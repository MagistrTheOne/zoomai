# Zoom Bot From Scratch

This repo is a demonstration of how to build a simple Zoom bot that joins and transcribes meetings in real time.

If you want to see a deeper dive into how I built this, check out the post on how to build a [Zoom bot](https://www.recall.ai/blog/how-to-build-a-zoom-bot).

## Demo
https://www.loom.com/share/ab898f02a5344fdbb89fdd4701bbaf10

## Hosted Zoom Meeting Bot API
If you want to use a hosted API that allows you to access conversation data from meetings instead of building and hosting your own bot, check out [Recall.ai's Meeting Bot API for Zoom](https://www.recall.ai/product/meeting-bot-api/zoom?utm_source=github&utm_medium=sampleapp&utm_campaign=zoom-bot-from-scratch).

## Requirements

- [Docker](https://docs.docker.com/get-docker/) must be installed and running.
- [Node.js](https://nodejs.org/en)

### Windows (Docker CLI not found)

The project resolves Docker Desktop’s default install path automatically, so `npm run docker:build` and **Invite Bot** usually work even when `docker` is not on your PATH.

If anything still fails: start **Docker Desktop**, open a **new** terminal, or add `C:\Program Files\Docker\Docker\resources\bin` to your user **PATH**. You can also set **`DOCKER_PATH`** in `.env` to the full path of `docker.exe`. Verify with `docker version` (Client and Server).

If you see **`docker-credential-desktop`: executable file not found**, the backend now prepends Docker Desktop’s `resources\bin` to `PATH` for spawned `docker` processes. Ensure Docker Desktop is installed in the default location, or add that folder to your system PATH.

Finish **`npm run docker:build`** before using **Invite Bot**; otherwise Docker reports that the **`zoom-bot:latest`** image is missing.

## How to Run

### 1. Clone the repo

```bash
git clone https://github.com/recall-ai/zoom-bot-from-scratch.git
cd zoom-bot-from-scratch
```

### 2. Set up the environment variables

Copy the `.env.example` file to `.env`. By default, the bot will not be running in debug mode. You can set `DEBUG=true` in your `.env` file to enable debug mode, which will launch the bot in headed mode.

```bash
cp .env.example .env
```

On Windows (PowerShell): `Copy-Item .env.example .env`

### 3. Build the Bot's Docker Image

This command builds the container image for our Zoom bot, which includes the Chromium browser and all necessary dependencies.

```bash
docker build -t zoom-bot .
```

Or from npm:

```bash
npm run docker:build
```

### 4. Install Dependencies and Start the Server

This will install the Node.js dependencies for the backend server and then start it.

```bash
npm install
npm run dev
```

The server will be running at `http://localhost:3000`.

### 5. Use the Web App

Open your web browser and navigate to `http://localhost:3000`.

Paste a Zoom meeting URL into the form and click "Invite Bot". You will see logs appear in your terminal as the backend server launches a new Docker container to run the bot for that meeting.

The live transcript will be saved to a `.jsonl` file inside the `src/transcripts` directory.

## Phase 1 Pilot (interview agent)

Orchestrator mode runs the Express UI on `PORT` (default 3000) and the **control plane** on `CONTROL_PORT` (default 8080). It starts Playwright **in-process** (up to `MAX_CONCURRENT_SESSIONS` concurrent sessions) and pipes **OpenAI** STT / LLM / TTS into the meeting via `AUDIO_OUT_MODE` (`browser_injection` for dev, `virtual_mic` + PulseAudio in Linux Docker).

### Environment

Copy `.env.example` to `.env` and set at least `OPENAI_API_KEY`. See `.env.example` for `OPENAI_*`, `AUDIO_OUT_MODE`, `AUDIO_CAPTURE_WS_PORT`, `MAX_CONCURRENT_SESSIONS`, `CONTROL_PORT`, `LOG_LEVEL`.

### Speech-to-text (STT)

Default **`STT_MODE=http_stream`**: energy VAD on incoming PCM splits utterances; each utterance is sent with **`POST /v1/audio/transcriptions`** and `stream=true`; partial text comes from SSE events (`transcript.text.delta` / `transcript.text.done`). Model default is **`OPENAI_STT_MODEL=gpt-4o-mini-transcribe`**. Official API: [Create transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

Alternatives: **`STT_MODE=whisper_chunked`** — fixed time windows + Whisper API (see `OPENAI_STT_CHUNK_MS`). **`STT_MODE=realtime_ws`** — Realtime WebSocket transcription. If **`STT_MODE` is omitted**, **`OPENAI_STT_USE_REALTIME=1`** still selects realtime (legacy alias).

### Build Docker (includes PulseAudio for `virtual_mic`)

```bash
npm run docker:build
```

Default container command is `node src/backend/index.js` (orchestrator). Legacy caption-only bot CLI:

```bash
docker run --rm -v "%CD%\src\transcripts:/app/transcripts" zoom-bot node src/bot/zoom_bot.js "https://zoom.us/j/..." "session-id"
```

### Start server

```bash
npm install
npm start
```

### Start a pilot interview session

```bash
curl -X POST http://localhost:8080/sessions -H "content-type: application/json" -d "{\"meetingUrl\":\"https://us05web.zoom.us/j/123456789\",\"scriptPath\":\"./examples/interview_backend_dev.yaml\",\"maxDurationSeconds\":900}"
```

### Inspect / stop

```bash
curl http://localhost:8080/sessions/<sessionId>
curl -X DELETE http://localhost:8080/sessions/<sessionId>
curl http://localhost:8080/healthz
curl http://localhost:8080/metrics
```

### Known limits

- Up to **10** concurrent sessions per process (configurable).
- **OpenAI** required for STT/LLM/TTS in Phase 1.
- **Single Node process** hosts sessions; resource usage scales with concurrent browsers.
- Live OpenAI integration tests: set `RUN_LIVE_TESTS=1` only for manual runs (not used in default `npm test`).
