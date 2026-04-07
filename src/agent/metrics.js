const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const e2eLatency = new client.Histogram({
  name: "nullxes_e2e_latency_ms",
  help: "End-to-end latency from user speech end to first agent audio frame",
  buckets: [200, 400, 700, 1000, 1500, 2500, 4000, 8000],
  registers: [register],
});

const sttFinalLatency = new client.Histogram({
  name: "nullxes_stt_final_latency_ms",
  help: "Time from VAD speech end to STT final transcript",
  buckets: [50, 100, 200, 400, 700, 1500, 3000],
  registers: [register],
});

const llmTtft = new client.Histogram({
  name: "nullxes_llm_ttft_ms",
  help: "LLM time-to-first-token from STT final",
  buckets: [100, 200, 400, 700, 1200, 2500],
  registers: [register],
});

const ttsTtfb = new client.Histogram({
  name: "nullxes_tts_ttfb_ms",
  help: "TTS time-to-first-byte from first LLM token",
  buckets: [50, 100, 200, 400, 700, 1500],
  registers: [register],
});

const bargeInTotal = new client.Counter({
  name: "nullxes_barge_in_total",
  help: "Total barge-in events across all sessions",
  registers: [register],
});

const activeSessions = new client.Gauge({
  name: "nullxes_active_sessions",
  help: "Currently active sessions",
  registers: [register],
});

module.exports = {
  register,
  e2eLatency,
  sttFinalLatency,
  llmTtft,
  ttsTtfb,
  bargeInTotal,
  activeSessions,
};
