# NULLXES AI — Audio plane specification (Zoom client ↔ NULLXES)

**Document status:** **v1.0 (implemented)** sections are grounded in `src/agent/audio_capture_bridge.js`, `src/agent/audio_bridge_singleton.js`, `src/bot/audio_capture.js`, `src/agent/audio_pacer.js`, `src/agent/audio_sink_pulse.js`, and `src/agent/session_worker.js`. **v1.1 / target** sections describe the full-duplex contract the C++ team may implement against; many items are **not** present in the repository today.

---

## 1. Overview

### 1.1 v1.0 (implemented) — mic ingress only

- NULLXES runs a **WebSocket server** (`AudioCaptureBridge`) that receives **binary PCM** frames from a browser context (Playwright-injected script in `audio_capture.js`).
- **Default bind:** `127.0.0.1` on port **`AUDIO_CAPTURE_WS_PORT`** (default **47001**) — see `audio_bridge_singleton.js`.
- **TTS output** in the current stack goes to **`AUDIO_OUT_MODE`**:
  - `browser_injection` (default): audio injected in-page (`audio_sink_browser.js`), **not** sent on this WebSocket.
  - `virtual_mic`: PCM written to PulseAudio via `pacat` (`audio_sink_pulse.js`), **not** sent on this WebSocket.

So the **implemented** WS audio plane is **simplex (client → server)** for microphone capture.

### 1.2 v1.1 (target) — full duplex on one connection

**TO BE IMPLEMENTED in v1.1:** Two-way real-time PCM over **one** WebSocket per session, NULLXES as **server**, C++ Zoom client as **client**, with TTS **audio_out** frames on the same socket as **mic_in**. This matches the integration goal described to client teams; it is **not** implemented as `/ws/audio` on `CONTROL_PORT` in the current tree.

---

## 2. Connection

### 2.1 v1.0 — implemented (`AudioCaptureBridge`)

| Item | Value |
|------|--------|
| URL pattern | `ws://<host>:<port>/?session=<sessionId>` |
| Host | `127.0.0.1` (hardcoded in `session_worker` for `injectMicCapture`) |
| Port | `AUDIO_CAPTURE_WS_PORT` \|\| **47001** |
| Query parameter name | **`session`** (not `sessionId`) |
| Path | Client may use `/`; server parses query via `new URL(req.url)` |

**Session validation:** The bridge **does not** check that `session` matches an active `SessionWorker` in `SessionRegistry`. Any value is accepted; frames are tagged by `session` and routed in `iteratePcmFrames(sessionId)`.

**Multiple connections:** **Not rejected** with a conflict code in v1.0. Multiple sockets with the same `session` would interleave frames — **TO BE DECIDED** for production.

### 2.2 v1.1 — target (control plane port)

**TO BE IMPLEMENTED in v1.1:**

```
ws://<nullxes-host>:8080/ws/audio?sessionId=<uuid>
```

- `sessionId` **must** match a session created via `POST /sessions`.
- **Suggested** close codes (not in v1.0 code): **4404** if session unknown, **4409** if duplicate connection.

**TO BE DECIDED:** Unify query name (`session` vs `sessionId`) across capture bridge and future `/ws/audio`.

---

## 3. Wire Format

### 3.1 v1.0 — implemented

| Property | Value |
|----------|--------|
| Message type | Binary WebSocket frames |
| PCM | **16-bit signed little-endian**, mono |
| Sample rate | **16000 Hz** (see `audio_capture.js` `TARGET_SR`) |
| Frame size constant | **640 bytes** = 320 samples = **20 ms** (`FRAME_BYTES` in `audio_capture_bridge.js`; `FRAME_SAMPLES` 320 in `audio_capture.js`) |

**Framing:** `injectMicCapture` sends **one binary message per 320-sample chunk** after downsampling.

**Note:** Upstream script processing uses variable input buffer sizes (4096) before downsampling; output is chunked to 320 samples.

### 3.2 v1.1 — target (full duplex)

Same PCM parameters for **both** directions on the **proposed** unified endpoint (see `docs/control_protocol.md` Open Questions).

---

## 4. Direction Semantics

### 4.1 Client → Server (mic_in) — v1.0 implemented

- **Source:** Candidate audio captured in Zoom (browser `getUserMedia`), forwarded to NULLXES for STT (`iteratePcmFrames` → `streamTranscribe`).
- **Send rate:** Browser implementation aims for ~20 ms chunks (320 samples at 16 kHz); **not** enforced with a WS-level timer in Node — **best effort** from `ScriptProcessor`/`onaudioprocess`.

**TO BE DECIDED:** Exact jitter when browser load is high.

### 4.2 Backpressure / queueing — v1.0

- `iteratePcmFrames` uses an in-memory queue + wake pattern; **no** `DropOldestQueue` in `audio_capture_bridge.js`.
- **Drop-oldest** queues exist in `src/agent/queues.js` for **other** components (tests/unit usage); **not** wired to the capture bridge in this codebase.

**TO BE IMPLEMENTED in v1.1:** Explicit overflow policy for C++ client (prompt recommends drop-oldest on server ingest — **not confirmed** in capture bridge).

### 4.3 Silence — v1.0

- Browser pipeline **continuously** processes audio frames when `ws.readyState === OPEN`; silence is not specially skipped in the capture script.

### 4.4 Server → Client (audio_out) — v1.0

- **Not** sent on `AudioCaptureBridge`. TTS is paced at **20 ms** per frame via `AudioPacer` (`FRAME_MS = 20`) into `createAudioSink` (browser or Pulse).

**TO BE IMPLEMENTED in v1.1:** TTS PCM over WebSocket to C++ virtual mic.

### 4.5 Barge-in — v1.0

- `AudioPacer.flush()` clears pending buffer and calls sink `flush()` (Pulse: respawns `pacat`; browser: implementation-specific).
- **TO BE DECIDED:** Latency for C++ client to drop queued frames (~40 ms in prompt) — **not** measured in WS layer (no WS TTS in v1.0).

---

## 5. Control Messages on the Audio Channel

**v1.0:** `AudioCaptureBridge` handles **binary** `message` events only; **no** JSON text handlers on the capture server.

**TO BE IMPLEMENTED in v1.1** (target contract from integration planning):

**Server → client**

| type | Purpose |
|------|---------|
| `flush` | Drop queued playback audio (barge-in). |
| `speaking_start` | Advisory: bot about to speak. |
| `speaking_end` | Advisory: bot finished. |

**Client → server**

| type | Purpose |
|------|---------|
| `vad_speech_start` | Optional; `ts` in ms if client VAD wants to short-circuit server VAD. |

---

## 6. Heartbeat

**v1.0:** `AudioCaptureBridge` does **not** configure WebSocket `ping`/`pong` intervals or **4408** timeout.

**TO BE IMPLEMENTED in v1.1:** PING every 10s, 5s PONG timeout — **as specified in integration goals; not in code.**

---

## 7. Disconnect and Reconnection

**v1.0:** On WebSocket `close`, the bridge emits `disconnect` with `session` id. **No** 30-second reconnect window, **no** pause of `SessionWorker` LLM/TTS pipeline tied to this event in `audio_capture_bridge.js`.

**TO BE IMPLEMENTED in v1.1:** Reconnect policy, `stopped_during_meeting` webhook, **TO BE DECIDED** mapping to actual `SessionWorker` lifecycle.

---

## 8. Performance Requirements

**v1.0:** Histograms in `src/agent/metrics.js` record latency distributions (`nullxes_e2e_latency_ms`, `nullxes_stt_final_latency_ms`, etc.). **No** hard enforcement of:

- RTT < 50 ms  
- mic→STT < 100 ms  
- TTS→speaker < 100 ms  
- jitter p99 < 20 ms  

These are **integration targets / TO BE DECIDED** for the C++ client and network, not guaranteed by NULLXES configuration.

---

## 9. Security

**v1.0 (implemented):** Capture bridge binds to **`127.0.0.1`** by default — localhost only.

**TO BE IMPLEMENTED in v1.1:** Bearer token in query, TLS (`wss`) — **not in code** for this bridge.

---

## 10. Open Questions for the Client

**Q1.** **One port** with `sessionId` in URL vs **port-per-session** pool? Same as `control_protocol.md` Q1. v1.0 uses **one port** per process for capture.

**Q2.** **Separate** endpoints for `audio_in` vs `audio_out` vs **one full-duplex** socket? v1.0: capture is **one** ingress-only WS; TTS is separate path. **TO BE DECIDED** for v1.1.

**Q3.** **Silent** frames: always send zero-PCM vs skip? NULLXES browser path sends continuous frames when open; **recommended** for VAD end-of-utterance — **TO BE CONFIRMED** for C++.

**Q4.** Align query parameter **`session`** (v1.0) vs **`sessionId`** (proposed `/ws/audio`) — naming standard for C++.

**Q5.** When `AUDIO_OUT_MODE=virtual_mic`, should TTS eventually move to the same WebSocket as mic capture for **one** C++ client binary? **TO BE DECIDED.**

---

## Appendix A — Environment variables (audio)

| Variable | Default | Role |
|----------|---------|------|
| `AUDIO_CAPTURE_WS_PORT` | `47001` | `AudioCaptureBridge` listen port |
| `AUDIO_OUT_MODE` | `browser_injection` | `virtual_mic` or `browser_injection` |

---

## Appendix B — Reference code map

| Concern | File |
|---------|------|
| WS server + frame size | `src/agent/audio_capture_bridge.js` |
| Singleton port | `src/agent/audio_bridge_singleton.js` |
| Browser mic → WS | `src/bot/audio_capture.js` |
| Frame pacing + flush | `src/agent/audio_pacer.js`, `src/agent/audio_sink_pulse.js` |
| Session wiring | `src/agent/session_worker.js` |

---

*End of audio plane specification.*
