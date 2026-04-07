const express = require("express");
const path = require("path");
const fs = require("fs");
const { SessionWorker } = require("../agent/session_worker");
const metrics = require("../agent/metrics");
const { createLogger } = require("../agent/logger");
const { validateOpenAIChainOrThrow } = require("../agent/openai_validate");

const log = createLogger();

/**
 * @param {{ sessionRegistry: import('./session_registry').SessionRegistry, transcriptsDir: string }} deps
 */
function createControlRouter(deps) {
  const r = express.Router();

  r.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  r.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metrics.register.contentType);
    res.end(await metrics.register.metrics());
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

    worker
      .run()
      .catch((e) => log.error({ err: String(e), sessionId }, "session failed"))
      .finally(() => {
        deps.sessionRegistry.releaseSession(sessionId, slot);
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
    const id = req.params.id;
    const w = deps.sessionRegistry.get(id);
    if (!w) return res.status(404).json({ error: "not found" });
    res.status(202).json({ status: "shutting_down" });
    w.gracefulShutdown("operator_stop")
      .catch((e) =>
        log.error({ err: String(e), sessionId: id }, "graceful_shutdown_failed")
      )
      .finally(() => {
        deps.sessionRegistry.releaseSession(id, w.slot);
      });
  });

  return { router: r };
}

module.exports = { createControlRouter };
