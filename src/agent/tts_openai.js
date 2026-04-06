const OpenAI = require("openai/index.mjs");
// verify against openai@^4.77 — audio.speech streaming + pcm response_format

const OUT_SR = 16000;
const IN_SR = 24000;

/**
 * Linear resample int16 mono from 24k to 16k
 * @param {Buffer} pcm24 int16 little-endian
 * @returns {Buffer}
 */
function resample24kTo16kPcm16(pcm24) {
  const inSamples = pcm24.length / 2;
  const inArr = new Int16Array(
    pcm24.buffer,
    pcm24.byteOffset,
    inSamples
  );
  const ratio = IN_SR / OUT_SR;
  const outLen = Math.floor(inSamples / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const j = Math.floor(src);
    const frac = src - j;
    const a = inArr[j] ?? 0;
    const b = inArr[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return Buffer.from(out.buffer);
}

/**
 * @param {{ textIter: AsyncIterable<string>, cancel: import('./cancel').CancelToken }} opts
 * @returns {AsyncGenerator<Buffer>}
 */
async function* streamSpeak(opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.OPENAI_TTS_VOICE || "alloy";

  let buf = "";
  for await (const delta of opts.textIter) {
    opts.cancel.throwIfCancelled();
    buf += delta;
    const m = buf.match(/([.!?]\s+|$)/);
    if (m && m.index !== undefined && m.index > 0) {
      const slice = buf.slice(0, m.index + 1).trim();
      buf = buf.slice(m.index + 1);
      if (slice.length > 0) {
        yield* synthChunk(client, { model, voice, input: slice, cancel: opts.cancel });
      }
    }
  }
  if (buf.trim().length > 0) {
    yield* synthChunk(client, { model, voice, input: buf.trim(), cancel: opts.cancel });
  }
}

async function* synthChunk(client, opts) {
  opts.cancel.throwIfCancelled();
  const response = await client.audio.speech.create({
    model: opts.model,
    voice: opts.voice,
    input: opts.input,
    response_format: "pcm",
  });

  const ab = await response.arrayBuffer();
  const acc = Buffer.from(ab);

  const pcm16 = resample24kTo16kPcm16(acc);
  const frame = 640;
  for (let i = 0; i < pcm16.length; i += frame) {
    opts.cancel.throwIfCancelled();
    yield pcm16.subarray(i, i + frame);
  }
}

module.exports = { streamSpeak, resample24kTo16kPcm16 };
