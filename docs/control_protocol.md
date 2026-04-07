# NULLXES AI — Control plane specification (JobAI ↔ NULLXES)

**Document status:** Derived from the `NULLXES_AI_AGENT_ZOOM` repository as of static review of `src/backend/control_server.js`, `src/backend/session_registry.js`, `src/backend/index.js`, and related session lifecycle. Sections marked **v1.0 (implemented)** match current code. Sections marked **v1.1 (TO BE IMPLEMENTED)** describe intended integration contracts for the C++ Zoom client and JobAI orchestrator; they are **not** implemented in this codebase today.

---

## 1. Overview

### 1.1 Components

| Component | Role |
|-----------|------|
| **JobAI Backend** | Orchestrator: creates interview sessions, may start/stop the Zoom micro-client, consumes status (future webhooks / polling). |
| **Zoom client (C++)** | Joins Zoom meetings, bridges audio (future), talks to NULLXES over HTTP/WebSocket as specified below. |
| **NULLXES AI (this backend)** | Node.js service: HTTP **control plane** on `CONTROL_PORT` (default **8080**), separate **main app** on `PORT` (default **3000**), runs `SessionWorker` + Playwright Zoom bot for each session. |

### 1.2 Trust boundary

- **NULLXES** exposes the HTTP control API (`control_server.js` on the control app) and Prometheus metrics.
- **v1.0:** There is **no** WebSocket `/ws/control` on the control app in code; the Zoom client does not yet connect to NULLXES over WS for lifecycle events in this repository.
- **JobAI** and the **C++ client** are trusted to call only the documented HTTP endpoints until WS + webhooks are implemented.

### 1.3 High-level sequence (target architecture)

```
JobAI Backend          Zoom client (C++)           NULLXES AI
      │                        │                        │
      │  POST /sessions        │                        │
      │──────────────────────────────────────────────────────►
      │                        │                        │
      │  sessionId             │                        │
      │◄─────────────────────────────────────────────────────
      │                        │                        │
      │  start session         │                        │
      │──────────────────────►│                        │
      │                        │  join meeting          │
      │                        │──────────────────────► Zoom
      │                        │                        │
      │  (future: WS control + webhooks)                    │
```

**v1.0 reality:** After `POST /sessions`, NULLXES starts `SessionWorker.run()` which launches the browser bot (`runZoomBot`) and does **not** wait for an external Zoom client. Concurrency and script loading are entirely server-side.

---

## 2. HTTP Control Plane (JobAI → NULLXES)

**Base URL:** `http://<nullxes-host>:<CONTROL_PORT>` where `CONTROL_PORT` defaults to **8080** (`process.env.CONTROL_PORT` in `src/backend/index.js`).

**Content-Type:** `application/json` for JSON bodies.

### 2.1 `GET /healthz`

**v1.0 — implemented**

| Item | Value |
|------|--------|
| Method | `GET` |
| Path | `/healthz` |

**Response 200**

```json
{ "ok": true }
```

**Errors:** None defined for this route.

**Example**

```bash
curl -sS http://localhost:8080/healthz
```

---

### 2.2 `GET /metrics`

**v1.0 — implemented**

| Item | Value |
|------|--------|
| Method | `GET` |
| Path | `/metrics` |

**Response 200**

- **Content-Type:** `metrics.register.contentType` from `prom-client` (typically `text/plain; version=0.0.4; charset=utf-8`).
- **Body:** Prometheus exposition format text (not JSON).

**Included series (from `src/agent/metrics.js`):** default Node metrics plus `nullxes_e2e_latency_ms`, `nullxes_stt_final_latency_ms`, `nullxes_llm_ttft_ms`, `nullxes_tts_ttfb_ms`, `nullxes_barge_in_total`, `nullxes_active_sessions`.

**Errors:** None defined.

**Example**

```bash
curl -sS http://localhost:8080/metrics | head
```

---

### 2.3 `POST /sessions`

**v1.0 — implemented** (with limitations below)

| Item | Value |
|------|--------|
| Method | `POST` |
| Path | `/sessions` |
| Body | JSON object |

#### Request body — **as implemented**

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `meetingUrl` | string | **Yes** | Must match Zoom URL regex: `zoom.(us|com)/(j|s|wc/join)/<digits>` (see `control_server.js`). |
| `scriptPath` | string | **Yes** | Path to interview YAML on **NULLXES filesystem**. If relative, resolved with `path.join(process.cwd(), scriptPath)`. File must exist **or** `400` with `scriptPath not found`. |
| `maxDurationSeconds` | number | No | Defaults to **900** if omitted or falsy (`Number(maxDurationSeconds \|\| 900)`). |
| `displayName` | string | No | Passed to `SessionWorker` / bot (`req.body.displayName`). |

**Fields present in destructuring but not used by the worker in v1.0:** `meetingId`, `passcode`, `candidateName`, `language` — they are **accepted in JSON** but **ignored** by the current handler (underscore-prefixed in code).

**TO BE IMPLEMENTED in v1.1 — `scriptInline`**

- **Intent:** Full interview YAML as a string so JobAI does not need a shared filesystem with NULLXES.
- **Current code:** Only `scriptPath` is supported; `loadScript` reads a file (`src/agent/interview/script.js`).
- **Required contract change:** Accept `scriptPath` **OR** `scriptInline` (mutually exclusive), parse YAML from `scriptInline` when provided.

**TO BE IMPLEMENTED in v1.1 — `webhookUrl`**

- Not read from `req.body` in `control_server.js`. See section 4.

#### Success response **200**

```json
{
  "sessionId": "<uuid>",
  "status": "started"
}
```

`sessionId` is `randomUUID()` from `session_registry.newSessionId()`.

#### Error responses

| HTTP | JSON body | When |
|------|-----------|------|
| 400 | `{ "error": "meetingUrl and scriptPath required" }` | Missing `meetingUrl` or `scriptPath`. |
| 400 | `{ "error": "Invalid Zoom meeting URL" }` | URL fails regex. |
| 400 | `{ "error": "scriptPath not found" }` | Resolved path does not exist. |
| 400 | `{ "error": "OPENAI_API_KEY is required" }` | `OPENAI_API_KEY` missing in environment. |
| 429 | `{ "error": "Too many concurrent sessions" }` | `allocateSlot()` returned `null` (slot pool exhausted). |
| 502 | `{ "error": "<message>" }` | `validateOpenAIChainOrThrow` failed (OpenAI chain validation). |

**Example**

```bash
curl -sS -X POST http://localhost:8080/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "meetingUrl": "https://zoom.us/j/1234567890",
    "scriptPath": "examples/smoke_test.yaml",
    "maxDurationSeconds": 120,
    "displayName": "NULLXES Bot"
  }'
```

---

### 2.4 `GET /sessions/:id`

**v1.0 — implemented**

| Item | Value |
|------|--------|
| Method | `GET` |
| Path | `/sessions/:id` |

#### Success response **200**

```json
{
  "state": "<string>",
  "timeElapsed": <number>,
  "timeRemaining": <number>,
  "currentQuestionId": "<string | null>",
  "transcriptPath": "<string>"
}
```

| Field | Meaning |
|-------|---------|
| `state` | `SessionWorker.fsmState` — see FSM states in `src/agent/interview/state_machine.js` (`GREETING`, `ASKING`, `LISTENING`, `FOLLOWUP`, `NEXT`, `WRAPPING_UP`, `CLOSED`). |
| `timeElapsed` | Seconds since session start: `(Date.now() - w.startedAt) / 1000`. |
| `timeRemaining` | `w.timeLeftSec()` (non-negative seconds until `maxDurationSeconds` budget). |
| `currentQuestionId` | `w.script.questions[w.questionIndex]?.id ?? null`. |
| `transcriptPath` | Absolute path to JSONL transcript file for this session. |

#### Error response **404**

```json
{ "error": "not found" }
```

**Example**

```bash
curl -sS http://localhost:8080/sessions/<session-uuid>
```

---

### 2.5 `GET /sessions` (list)

**TO BE IMPLEMENTED in v1.1**

- **Current code:** No `GET /sessions` without `:id` in `control_server.js`. Integrators must use **metrics** (`nullxes_active_sessions`) or track `sessionId` from `POST` responses until a list endpoint exists.

---

### 2.6 `DELETE /sessions/:id`

**v1.0 — implemented** (graceful shutdown)

| Item | Value |
|------|--------|
| Method | `DELETE` |
| Path | `/sessions/:id` |

**Behavior:** Returns **202** immediately, then runs `worker.gracefulShutdown("operator_stop")` in the background; on completion, `releaseSession(id, w.slot)` runs (registry + metrics).

#### Success response **202**

```json
{ "status": "shutting_down" }
```

#### Error response **404**

```json
{ "error": "not found" }
```

**Example**

```bash
curl -sS -X DELETE http://localhost:8080/sessions/<session-uuid>
```

---

### 2.7 Concurrency and lifecycle (registry)

**v1.0 — implemented** (`src/backend/session_registry.js`)

- Max concurrent sessions: `MAX_CONCURRENT_SESSIONS` env (default **10**).
- Each successful `POST /sessions` calls `allocateSlot()` before registering; `releaseSlot`/`releaseSession` return slot on exit.
- `nullxes_active_sessions` gauge: incremented on `set`, decremented on `unregister` (via `releaseSession`).

---

## 3. WebSocket Control Channel (Zoom client ↔ NULLXES)

**Document status:** The message types and URL below are the **target contract** for C++ integration. **They are not implemented** in the current Node control app (`createControlRouter` only registers HTTP routes; no `WebSocketServer` on port 8080).

### 3.1 Connection (target)

```
ws://<nullxes-host>:8080/ws/control?sessionId=<uuid>
```

Establish **after** successful `POST /sessions` returns `sessionId`.

**v1.0 (implemented):** NULLXES does not expose this endpoint.

### 3.2 Framing (target)

- JSON text frames only.
- Every message includes a **`type`** field (string).

### 3.3 Messages — Zoom client → NULLXES (target)

| type | Additional fields | Purpose |
|------|-------------------|---------|
| `zoom_joined` | `meetingId`, `participantCount` | Meeting joined. |
| `zoom_participant_joined` | `name`, `role` | Participant joined. |
| `zoom_participant_left` | `name` | Participant left. |
| `zoom_meeting_ended` | `reason` | Meeting ended. |
| `zoom_error` | `code`, `message` | Error reporting. |

**TO BE DECIDED:** Field types (`meetingId` string vs number), `role` enum, `reason` vocabulary — not defined in NULLXES code.

### 3.4 Messages — NULLXES → Zoom client (target)

| type | Additional fields | Purpose |
|------|-------------------|---------|
| `agent_ready` | — | Greeting about to play. |
| `agent_speaking` | — | Start of bot utterance. |
| `agent_silent` | — | End of bot utterance. |
| `session_completed` | `reason`: `"time_up"` \| `"natural"` \| `"operator_stop"` | Session finished. |
| `leave_meeting` | — | Request client to leave Zoom. |

**TO BE DECIDED:** Mapping from internal `SessionWorker` / `gracefulShutdown(reason)` strings to these `reason` values — partially inferable from `session_worker.js` (`operator_stop`, `signal_SIGTERM`, …) but not wired to WS.

---

## 4. Webhook Status Events (NULLXES → JobAI Backend)

**TO BE IMPLEMENTED in v1.1**

- **Current code:** `POST /sessions` does **not** read `webhookUrl` or post callbacks.
- **Target behavior (for client alignment):**

When JobAI includes `webhookUrl` in `POST /sessions`, NULLXES should POST status updates to that URL.

**Suggested payload schema (not in code):**

```json
{
  "sessionId": "uuid",
  "status": "in_meeting",
  "timestamp": "ISO8601",
  "metadata": {}
}
```

**Suggested status strings (align with client diagram):**

| Status | Meaning (proposal) |
|--------|------------------------|
| `failed_audio_pool_busy` | Zoom client reported audio pool full |
| `failed_connect_ws_audio` | Audio WebSocket handshake failed |
| `failed_zoom_start` | Zoom client failed to join meeting |
| `in_meeting` | Agent live, conducting interview |
| `stopped_during_meeting` | Candidate left or meeting ended early |
| `completed` | Interview reached closing cleanly |

**Suggested `metadata` for `completed`:** `transcriptPath`, `durationSeconds`, `questionsAsked`, `agentTotalCharsSpoken`, `candidateTotalCharsSpoken` — **none of these aggregates are computed in the current webhook-less code path**; transcript exists as JSONL; FSM state available via `GET /sessions/:id`.

**Delivery semantics (proposal):** at-least-once with retries (3, exponential backoff), **TO BE IMPLEMENTED**. **24h persistence** of undelivered status for JobAI polling — **NOT in code**.

**Fallback:** `GET /sessions/:id` returns current `state` and paths today; **polling contract** for terminal states is **TO BE DECIDED** (e.g. whether `CLOSED` implies `completed` vs `stopped_during_meeting` — the current FSM does not expose those string enums on HTTP).

---

## 5. Sequence Diagrams (ASCII)

### 5.1 Successful interview (target + v1.0 partial)

**Target (full integration):**

```
JobAI                Zoom client              NULLXES
  │                      │                      │
  │ POST /sessions       │                      │
  │─────────────────────────────────────────────►
  │ 200 sessionId        │                      │
  │◄─────────────────────────────────────────────
  │                      │                      │
  │ start session        │                      │
  │─────────────────────►│                      │
  │                      │ (future WS control)  │
  │                      │──────────────────────►│
  │                      │                      │
  │ POST webhook in_meeting (v1.1)               │
  │◄─────────────────────────────────────────────
  │                      │                      │
  │ ... interview ...    │                      │
  │                      │                      │
  │ POST webhook completed (v1.1)               │
  │◄─────────────────────────────────────────────
```

**v1.0 (implemented):** NULLXES does not receive `zoom_joined` over WS; bot joins via Playwright directly. No webhooks.

---

### 5.2 Audio pool exhausted (target)

```
JobAI                Zoom client              NULLXES
  │                      │                      │
  │ POST /sessions       │                      │
  │─────────────────────────────────────────────►
  │ 200 sessionId        │                      │
  │◄─────────────────────────────────────────────
  │                      │ reserve audio slot   │
  │                      │─────────────────► FAIL
  │ POST failed_audio_pool_busy (v1.1)          │
  │◄─────────────────────│                      │
```

**TO BE DECIDED:** Whether NULLXES or only the C++ client reports `failed_audio_pool_busy` to JobAI — see Open Questions.

---

### 5.3 Candidate leaves mid-interview (target)

```
Zoom client              NULLXES
      │                      │
      │ zoom_meeting_ended     │
      │──────────────────────►│
      │                      │ cancel turn, partial transcript
      │ POST webhook stopped_during_meeting (v1.1) → JobAI
```

**v1.0:** Meeting end is handled inside `zoom_bot.js` / `leaveMeeting` flows; **no** `zoom_meeting_ended` WebSocket message exists in this repo.

---

## 6. Open Questions for the Client

**Q1.** WebSocket audio plane: **one port** with `sessionId` in the handshake vs **one port per session** from a pool? NULLXES reference implementation uses a **single** `AudioCaptureBridge` port with `?session=` query (`src/agent/audio_bridge_singleton.js`, `audio_capture_bridge.js`). **See `docs/audio_protocol.md`.**

**Q2.** Who sends webhooks to JobAI — **NULLXES only**, **Zoom client only**, or **both**? Current code: **neither**. Recommended single writer to avoid duplicate/racy events.

**Q3.** Connection order: NULLXES session ready **before** vs **after** Zoom join? **TO BE DECIDED**; v1.0 starts bot immediately after `POST /sessions`.

**Q4.** Interview YAML delivery: (a) `scriptPath` on NULLXES disk — **implemented**; (b) `scriptInline` in POST — **TO BE IMPLEMENTED v1.1**; (c) fetch by vacancy ID from JobAI DB — **not in code**.

**Q5.** Webhook delivery vs polling: implement **both** (webhook + retry + `GET /sessions/:id` fallback) or polling only for MVP? **TO BE DECIDED**.

**Q6.** Should `GET /sessions` list all active sessions with filters? **Not implemented** — needed for ops/JobAI?

**Q7.** How should HTTP map to terminal outcomes (`completed` vs `stopped_during_meeting`) when `state === "CLOSED"`? **TO BE DECIDED** — FSM does not currently expose that distinction on `GET /sessions/:id`.

---

## 7. Error Codes Reference

### 7.1 HTTP (`control_server.js` and related)

| HTTP | `error` / body | Meaning |
|------|-------------------|---------|
| 400 | `meetingUrl and scriptPath required` | Validation failed. |
| 400 | `Invalid Zoom meeting URL` | Regex check failed. |
| 400 | `scriptPath not found` | File missing after resolve. |
| 400 | `OPENAI_API_KEY is required` | Env not set. |
| 404 | `not found` | Unknown `sessionId` for `GET`/`DELETE`. |
| 429 | `Too many concurrent sessions` | Slot pool full. |
| 502 | OpenAI validation message | `validateOpenAIChainOrThrow` failed. |

### 7.2 Internal cancellation (not HTTP)

| Code | Where | Meaning |
|------|--------|---------|
| `CANCELLED` | `CancelToken.throwIfCancelled()` (`src/agent/cancel.js`) | Session cancelled cooperatively; internal use, not HTTP. |

### 7.3 WebSocket `zoom_error` (target, not implemented)

**TO BE DECIDED:** `code` namespace and HTTP mapping — **no** implementation in NULLXES control plane yet.

---

## Appendix: Process signals (`src/backend/index.js`)

| Signal | Behavior |
|--------|----------|
| `SIGTERM` | `drainAndExit`: `gracefulShutdown` for all workers in `sessionRegistry.listAll()`, then `releaseSession` per worker, `process.exit(0)`. |
| `SIGINT` | Same as `SIGTERM`. |

A **15s** timeout is registered (second handler) to `process.exit(1)` if shutdown hangs — **not** exposed as HTTP.

---

*End of control plane specification.*
