const express = require("express");
const path = require("path");
const fs = require("fs");
const client = require("prom-client");
const { SessionWorker } = require("../agent/session_worker");
const { createLogger } = require("../agent/logger");
const { validateOpenAIChainOrThrow } = require("../agent/openai_validate");

const log = createLogger();

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const e2eLatency = new client.Histogram({
  name: "nullxes_e2e_latency_ms",
  help: "End-to-end latency ms (placeholder)",
  buckets: [50, 100, 250, 500, 1000, 1500, 3000],
  registers: [registry],
});

const sttFinalLatency = new client.Histogram({
  name: "nullxes_stt_final_latency_ms",
  help: "STT final latency ms (placeholder)",
  buckets: [100, 200, 400, 800, 1600],
  registers: [registry],
});

const llmTtft = new client.Histogram({
  name: "nullxes_llm_ttft_ms",
  help: "LLM time to first token ms (placeholder)",
  buckets: [50, 100, 200, 400, 800],
  registers: [registry],
});

const ttsTtfb = new client.Histogram({
  name: "nullxes_tts_ttfb_ms",
  help: "TTS time to first byte ms (placeholder)",
  buckets: [20, 50, 100, 200, 400],
  registers: [registry],
});

const bargeInTotal = new client.Counter({
  name: "nullxes_barge_in_total",
  help: "Barge-in events",
  registers: [registry],
});

const activeSessions = new client.Gauge({
  name: "nullxes_active_sessions",
  help: "Active sessions",
  registers: [registry],
});

/**
 * @param {{ sessionRegistry: import('./session_registry').SessionRegistry, transcriptsDir: string }} deps
 */
function createControlRouter(deps) {
  const r = express.Router();

  r.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  r.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  r.post("/sessions", express.json(), async (req, res) => {
    const {
      meetingUrl,
      meetingId: _meetingId,
      passcode: _passcode,
      displayName: _displayName,
      scriptPath,
      maxDurationSeconds,
      candidateName: _candidateName,
      language: _language,
    } = req.body || {};

    if (!meetingUrl || !scriptPath) {
      return res.status(400).json({ error: "meetingUrl and scriptPath required" });
    }

    const zoomRegex = /zoom\.(us|com)\/(?:j|s|wc\/join)\/(\d+)/i;
    if (!zoomRegex.test(meetingUrl)) {
      return res.status(400).json({ error: "Invalid Zoom meeting URL" });
    }

    const slot = deps.sessionRegistry.allocateSlot();
    if (slot === null) {
      return res.status(429).json({ error: "Too many concurrent sessions" });
    }

    const scriptResolved = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(process.cwd(), scriptPath);

    if (!fs.existsSync(scriptResolved)) {
      deps.sessionRegistry.releaseSlot(slot);
      return res.status(400).json({ error: "scriptPath not found" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      deps.sessionRegistry.releaseSlot(slot);
      return res.status(400).json({ error: "OPENAI_API_KEY is required" });
    }

    try {
      await validateOpenAIChainOrThrow(apiKey);
    } catch (e) {
      deps.sessionRegistry.releaseSlot(slot);
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg }, "OpenAI model validation failed");
      return res.status(502).json({ error: msg });
    }

    const sessionId = deps.sessionRegistry.newSessionId();
    const transcriptPath = path.join(deps.transcriptsDir, `${sessionId}.jsonl`);

    const worker = new SessionWorker({
      sessionId,
      meetingUrl,
      transcriptPath,
      scriptPath: scriptResolved,
      maxDurationSeconds: Number(maxDurationSeconds || 900),
      slot,
      headless: process.env.HEADLESS !== "0",
      displayName: req.body.displayName,
    });

    deps.sessionRegistry.set(sessionId, worker);
    activeSessions.set(deps.sessionRegistry.size);

    worker
      .run()
      .catch((e) => log.error({ err: String(e), sessionId }, "session failed"))
      .finally(() => {
        deps.sessionRegistry.unregister(sessionId);
        deps.sessionRegistry.releaseSlot(slot);
        activeSessions.set(deps.sessionRegistry.size);
      });

    res.json({ sessionId, status: "started" });
  });

  r.get("/sessions/:id", (req, res) => {
    const w = deps.sessionRegistry.get(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    res.json({
      state: w.fsmState,
      timeElapsed: (Date.now() - w.startedAt) / 1000,
      timeRemaining: w.timeLeftSec(),
      currentQuestionId:
        w.script.questions[w.questionIndex]?.id ?? null,
      transcriptPath: w.transcriptPath,
    });
  });

  r.delete("/sessions/:id", (req, res) => {
    const w = deps.sessionRegistry.get(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    w.sessionCancel.cancel();
    res.json({ ok: true });
  });

  return { router: r, metrics: { e2eLatency, sttFinalLatency, llmTtft, ttsTtfb, bargeInTotal, activeSessions } };
}

module.exports = { createControlRouter };
