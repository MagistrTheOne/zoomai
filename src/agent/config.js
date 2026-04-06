/*
 * Model selection rationale (per https://developers.openai.com/api/docs/guides/audio):
 *
 * We use the chained pattern (STT → LLM → TTS) over specialized Audio APIs,
 * NOT the Realtime API and NOT gpt-audio/gpt-realtime native speech-to-speech.
 * Reason: this is a structured interview agent. We need exact control over
 * what the bot says (script + FSM), which the speech-to-speech models cannot
 * give us — they generate audio directly and the script becomes a suggestion
 * rather than a contract.
 *
 * STT: gpt-4o-mini-transcribe
 *   - supports HTTP streaming (stream=true on /v1/audio/transcriptions)
 *   - lower latency and cost than full-size transcribe models
 *   - quality is sufficient for short interview turns
 *   - we chunk by VAD endpoints, one HTTP request per utterance
 *
 * LLM: gpt-4.1-mini
 *   - text-only model on Chat Completions with stream=true
 *   - fast time-to-first-token, which is the bottleneck in our 1500ms budget
 *   - we feed token deltas straight into TTS for parallel speech synthesis
 *   - we do NOT use gpt-audio here: gpt-audio is for native multimodal chat,
 *     not for a chained pipeline with a separate TTS stage
 *
 * TTS: gpt-4o-mini-tts
 *   - streaming PCM output on /v1/audio/speech
 *   - supports the `instructions` parameter for tone/style steering
 *   - lower latency than tts-1-hd; quality is sufficient for conversational use
 *
 * Diarization (transcribe-diarize models) is NOT used in the live pipeline
 * because it has no streaming mode. It is reserved for post-session transcript
 * enrichment after a session ends (future work).
 */

const { createLogger } = require("./logger");

const DEFAULT_OPENAI_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_OPENAI_LLM_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_TTS_VOICE = "alloy";
const DEFAULT_STT_MODE = "http_stream";

/**
 * @returns {'http_stream' | 'whisper_chunked' | 'realtime_ws'}
 */
function resolveSttMode() {
  const explicit = (process.env.STT_MODE || "").trim();
  if (explicit) {
    if (
      explicit !== "http_stream" &&
      explicit !== "whisper_chunked" &&
      explicit !== "realtime_ws"
    ) {
      throw new Error(
        `Invalid STT_MODE="${explicit}" (expected http_stream, whisper_chunked, or realtime_ws)`
      );
    }
    return /** @type {const} */ (explicit);
  }
  if (process.env.OPENAI_STT_USE_REALTIME === "1") return "realtime_ws";
  return "http_stream";
}

function getSttModel() {
  return process.env.OPENAI_STT_MODEL || DEFAULT_OPENAI_STT_MODEL;
}

function getResolvedModels() {
  const sttMode = resolveSttMode();
  return {
    stt: getSttModel(),
    llm: process.env.OPENAI_LLM_MODEL || DEFAULT_OPENAI_LLM_MODEL,
    tts: process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL,
    voice: process.env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE,
    sttMode,
  };
}

/**
 * One-line INFO log of pinned models (after dotenv is loaded).
 */
function logResolvedModelsAtStartup() {
  const log = createLogger();
  const m = getResolvedModels();
  log.info(
    `[config] models: stt=${m.stt} llm=${m.llm} tts=${m.tts} voice=${m.voice} stt_mode=${m.sttMode}`
  );
}

module.exports = {
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_LLM_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
  DEFAULT_OPENAI_TTS_VOICE,
  DEFAULT_STT_MODE,
  resolveSttMode,
  getSttModel,
  getResolvedModels,
  logResolvedModelsAtStartup,
};
