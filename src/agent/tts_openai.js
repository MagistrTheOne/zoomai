// verify against openai@^4.77 — /v1/audio/speech + pcm response_format

const { getResolvedModels } = require("./config");

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
 * @param {{ textIter: AsyncIterable<string>, cancel: import('./cancel').CancelToken, instructions?: string }} opts
 * @returns {AsyncGenerator<Buffer>}
 */
async function* streamSpeak(opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");
  const { tts: model, voice } = getResolvedModels();
  const instructions = opts.instructions;

  let buf = "";
  for await (const delta of opts.textIter) {
    opts.cancel.throwIfCancelled();
    buf += delta;
    const m = buf.match(/([.!?]\s+|$)/);
    if (m && m.index !== undefined && m.index > 0) {
      const slice = buf.slice(0, m.index + 1).trim();
      buf = buf.slice(m.index + 1);
      if (slice.length > 0) {
        yield* synthChunk({
          apiKey,
          model,
          voice,
          input: slice,
          cancel: opts.cancel,
          instructions,
        });
      }
    }
  }
  if (buf.trim().length > 0) {
    yield* synthChunk({
      apiKey,
      model,
      voice,
      input: buf.trim(),
      cancel: opts.cancel,
      instructions,
    });
  }
}

/**
 * @param {{ apiKey: string, model: string, voice: string, input: string, cancel: import('./cancel').CancelToken, instructions?: string }} opts
 */
async function* synthChunk(opts) {
  opts.cancel.throwIfCancelled();
  const ac = new AbortController();
  const unsub = opts.cancel.subscribe(() => ac.abort());
  try {
    const body = {
      model: opts.model,
      voice: opts.voice,
      input: opts.input,
      response_format: "pcm",
    };
    if (opts.instructions && String(opts.instructions).trim()) {
      body.instructions = String(opts.instructions).trim();
    }

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`TTS HTTP ${res.status}: ${t.slice(0, 400)}`);
    }

    const ab = await res.arrayBuffer();
    const acc = Buffer.from(ab);

    const pcm16 = resample24kTo16kPcm16(acc);
    const frame = 640;
    for (let i = 0; i < pcm16.length; i += frame) {
      opts.cancel.throwIfCancelled();
      yield pcm16.subarray(i, i + frame);
    }
  } finally {
    unsub();
  }
}

module.exports = { streamSpeak, resample24kTo16kPcm16 };
