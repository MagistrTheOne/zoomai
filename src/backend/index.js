const express = require("express");
const http = require("http");
const uuid = require("uuid");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { runZoomBot } = require("../bot/zoom_bot");
const {
  resolveDockerExecutable,
  envWithDockerResourcesInPath,
} = require("./docker_resolve");
const { SessionRegistry } = require("./session_registry");
const { createControlRouter } = require("./control_server");
const { createLogger } = require("../agent/logger");

dotenv.config();
const log = createLogger();
const { logResolvedModelsAtStartup } = require("../agent/config");
logResolvedModelsAtStartup();
log.info(
  { audioMode: process.env.AUDIO_OUT_MODE || "browser_injection" },
  "audio_out_mode_active"
);

/** POST /api/invite_bot: Docker only when USE_DOCKER_BOT=true (image zoom-bot + daemon). Default: in-process. */
const inviteBotViaDocker =
  process.env.USE_DOCKER_BOT === "true" && process.env.DEBUG !== "true";
log.info(
  { transport: inviteBotViaDocker ? "docker" : "in_process" },
  "invite_bot_transport"
);

const app = express();
const PORT = process.env.PORT || 3000;
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8080);

const sessionRegistry = new SessionRegistry();

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const transcriptsDir = path.join(__dirname, "..", "transcripts");
if (!fs.existsSync(transcriptsDir)) {
  fs.mkdirSync(transcriptsDir);
}

app.post("/api/invite_bot", (req, res) => {
  const { meetingUrl } = req.body;
  if (!meetingUrl) {
    return res.status(400).json({ error: "Missing meetingUrl query param" });
  }

  const zoomRegex = /zoom\.(us|com)\/(?:j|s|wc\/join)\/(\d+)/i;
  if (!zoomRegex.test(meetingUrl)) {
    return res.status(400).json({ error: "Invalid Zoom meeting URL" });
  }

  const botId = uuid.v4();

  if (!inviteBotViaDocker) {
    const headless = process.env.HEADLESS !== "0";
    runZoomBot(
      meetingUrl,
      path.join(transcriptsDir, `${botId}.jsonl`),
      headless,
      {}
    ).catch((err) => {
      log.error({ err: String(err), botId }, "invite_bot_run_failed");
    });
  } else {
    const botProcess = spawn(
      resolveDockerExecutable(),
      [
        "run",
        "--rm",
        "--name",
        `zoom-bot-${botId}`,
        "-v",
        `${transcriptsDir}:/app/transcripts`,
        "zoom-bot",
        "node",
        "src/bot/zoom_bot.js",
        meetingUrl,
        botId,
      ],
      { env: envWithDockerResourcesInPath() }
    );

    botProcess.stdout.on("data", (data) => {
      console.log(`[bot:${botId}] stdout: ${data}`);
    });

    botProcess.stderr.on("data", (data) => {
      console.error(`[bot:${botId}] stderr: ${data}`);
    });

    botProcess.on("close", (code) => {
      console.log(`[bot:${botId}] process exited with code ${code}`);
    });
  }

  res.json({ status: "bot_invited", botId });
});

app.get("/api/transcript/:botId", (req, res) => {
  const { botId } = req.params;
  const transcriptPath = path.join(transcriptsDir, `${botId}.jsonl`);

  if (!fs.existsSync(transcriptPath)) {
    return res.json([]);
  }

  try {
    const fileContent = fs.readFileSync(transcriptPath, "utf-8");
    const lines = fileContent.trim().split("\n");
    const rawTranscript = lines.map((line) => JSON.parse(line));

    const processedTranscript = [];
    let lastSpeaker = null;
    let lastTimestamp = 0;

    for (const chunk of rawTranscript) {
      if (lastSpeaker === chunk.speaker && chunk.time - lastTimestamp < 2) {
        const lastEntry = processedTranscript[processedTranscript.length - 1];
        lastEntry.text += ` ${chunk.text}`;
        lastEntry.time = chunk.time;
      } else {
        processedTranscript.push({ ...chunk });
      }
      lastSpeaker = chunk.speaker;
      lastTimestamp = chunk.time;
    }

    res.json(processedTranscript);
  } catch (err) {
    console.error(`[api] error reading transcript for bot ${botId}:`, err);
    res.status(500).json({ error: "Failed to read transcript file" });
  }
});

const { router: controlRouter } = createControlRouter({
  sessionRegistry,
  transcriptsDir,
});

const controlApp = express();
controlApp.use(controlRouter);

http.createServer(app).listen(PORT, () => {
  console.log(`Express server listening on http://localhost:${PORT}`);
});

http.createServer(controlApp).listen(CONTROL_PORT, () => {
  console.log(`Control plane listening on http://localhost:${CONTROL_PORT}`);
});

let shuttingDown = false;
async function drainAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutdown_signal_received");
  const sessions = sessionRegistry.listAll();
  await Promise.allSettled(
    sessions.map((worker) => worker.gracefulShutdown(`signal_${signal}`))
  );
  for (const w of sessions) {
    sessionRegistry.releaseSession(w.sessionId, w.slot);
  }
  log.info("shutdown_complete");
  process.exit(0);
}

process.on("SIGTERM", () => {
  drainAndExit("SIGTERM");
});
process.on("SIGINT", () => {
  drainAndExit("SIGINT");
});

setTimeout(() => {}, 0);
process.on("SIGTERM", () =>
  setTimeout(() => process.exit(1), 15_000).unref()
);
process.on("SIGINT", () =>
  setTimeout(() => process.exit(1), 15_000).unref()
);
