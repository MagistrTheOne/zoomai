const { OpenAI } = require("openai");
const { pcm16ToWav } = require("./stt_openai");
const { getResolvedModels } = require("./config");
const { createLogger } = require("./logger");

const log = createLogger();

/**
 * Fail fast at session start if API key or configured model IDs are rejected (403/404/invalid).
 * @param {string} apiKey
 */
async function validateOpenAIChainOrThrow(apiKey) {
  const client = new OpenAI({ apiKey });
  const { stt, llm, tts, voice, sttMode } = getResolvedModels();

  try {
    await client.chat.completions.create({
      model: llm,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    log.error({ err: msg, model: llm }, "OpenAI LLM model rejected or unavailable");
    throw new Error(
      `LLM model "${llm}" failed validation: ${msg}. Fix OPENAI_LLM_MODEL or account access.`
    );
  }

  try {
    await client.audio.speech.create({
      model: tts,
      voice,
      input: "ok",
      response_format: "pcm",
    });
  } catch (e) {
    const msg = e?.message || String(e);
    log.error({ err: msg, model: tts, voice }, "OpenAI TTS model/voice rejected");
    throw new Error(
      `TTS model "${tts}" / voice "${voice}" failed validation: ${msg}. Fix OPENAI_TTS_MODEL / OPENAI_TTS_VOICE.`
    );
  }

  if (sttMode === "http_stream") {
    await validateTranscriptionModel(apiKey, stt, "STT (http_stream)");
  } else if (sttMode === "whisper_chunked") {
    const w = process.env.OPENAI_STT_WHISPER_MODEL;
    if (!w || !String(w).trim()) {
      log.error(
        {},
        "OPENAI_STT_WHISPER_MODEL is required when STT_MODE=whisper_chunked"
      );
      throw new Error(
        "OPENAI_STT_WHISPER_MODEL is required when STT_MODE=whisper_chunked"
      );
    }
    await validateTranscriptionModel(apiKey, w.trim(), "STT (whisper_chunked)");
  } else if (sttMode === "realtime_ws") {
    const rm = process.env.OPENAI_REALTIME_MODEL;
    if (!rm || !String(rm).trim()) {
      log.error({}, "OPENAI_REALTIME_MODEL is required when STT_MODE=realtime_ws");
      throw new Error(
        "OPENAI_REALTIME_MODEL is required when STT_MODE=realtime_ws"
      );
    }
    log.info({ model: rm }, "STT realtime_ws: skipping HTTP transcription probe; ensure Realtime access");
  }
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {string} label
 */
async function validateTranscriptionModel(apiKey, model, label) {
  const wav = pcm16ToWav(Buffer.alloc(3200));
  const blob = new Blob([wav], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "probe.wav");
  form.append("model", model);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const t = await res.text();
    const msg = `HTTP ${res.status}: ${t.slice(0, 400)}`;
    log.error({ err: msg, model, label }, "OpenAI transcription model rejected");
    throw new Error(
      `${label}: transcription model "${model}" failed validation: ${msg}`
    );
  }
}

module.exports = { validateOpenAIChainOrThrow };
