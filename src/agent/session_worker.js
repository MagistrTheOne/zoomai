const fs = require("fs").promises;
const { runZoomBot } = require("../bot/zoom_bot");
const { injectMicCapture } = require("../bot/audio_capture");
const { leaveMeeting } = require("../bot/browser_utils");
const { createAudioSink } = require("./audio_sink");
const { setupBrowserAudioSink } = require("./audio_sink_browser");
const { CancelToken } = require("./cancel");
const { streamTranscribe } = require("./stt_openai");
const { streamSpeak } = require("./tts_openai");
const { AudioPacer } = require("./audio_pacer");
const { iteratePcmFrames } = require("./audio_capture_bridge");
const { getOrCreateAudioBridge, getBridgePort } = require("./audio_bridge_singleton");
const { loadScript } = require("./interview/script");
const { InterviewMemory } = require("./interview/memory");
const { States, Events, next } = require("./interview/state_machine");
const { buildSystemPrompt } = require("./interview/persona");
const { streamReply } = require("./llm_openai");
const { createLogger } = require("./logger");

class InterruptController {
  constructor() {
    /** @type {import('./cancel').CancelToken | null} */
    this._current = null;
  }

  begin() {
    this.cancelActive();
    const t = new CancelToken();
    this._current = t;
    return t;
  }

  cancelActive() {
    if (this._current) this._current.cancel();
    this._current = null;
  }
}

class SessionWorker {
  /**
   * @param {{
   *   sessionId: string,
   *   meetingUrl: string,
   *   transcriptPath: string,
   *   scriptPath: string,
   *   maxDurationSeconds: number,
 *   slot: number,
 *   headless?: boolean,
 *   displayName?: string,
 * }} opts
 */
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.meetingUrl = opts.meetingUrl;
    this.transcriptPath = opts.transcriptPath;
    this.script = loadScript(opts.scriptPath);
    this.maxDurationSeconds = opts.maxDurationSeconds;
    this.slot = opts.slot;
    this.headless = opts.headless !== false;
    this.displayName = opts.displayName;
    this.log = createLogger(opts.sessionId);
    this.memory = new InterviewMemory();
    this.sessionCancel = new CancelToken();
    this.interrupt = new InterruptController();
    this.fsmState = States.GREETING;
    this.questionIndex = 0;
    this.startedAt = Date.now();
    this.timeLowFired = false;
    /** @type {number} */
    this._turnId = 0;
    /** @type {{ vadSpeechEndMs: number, sttFinalMs: number } | null} */
    this._lastSttTiming = null;
    /** @type {number | null} */
    this._currentTurnFirstSinkMs = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._timer = null;
    /** @type {import('playwright-core').Page | null} */
    this._page = null;
    /** @type {AudioPacer | null} */
    this._pacer = null;
  }

  timeLeftSec() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    return Math.max(0, this.maxDurationSeconds - elapsed);
  }

  async appendLine(obj) {
    await fs.appendFile(
      this.transcriptPath,
      JSON.stringify(obj) + "\n",
      "utf8"
    );
  }

  async run() {
    await runZoomBot(this.meetingUrl, this.transcriptPath, this.headless, {
      waitRoomLimitMs: 5 * 60_000,
      pulseSlot: this.slot,
      sessionId: this.sessionId,
      cancelToken: this.sessionCancel,
      displayName: this.displayName,
      agent: { runInCall: (ctx) => this.runInCall(ctx) },
    });
  }

  /**
   * @param {{ page: import('playwright-core').Page }} ctx
   */
  async runInCall(ctx) {
    const { page } = ctx;
    this._page = page;
    const t0 = Date.now();
    const ts = () => (Date.now() - t0) / 1000;

    this._timer = setInterval(() => {
      const left = this.timeLeftSec();
      if (!this.timeLowFired && left <= 90) {
        this.timeLowFired = true;
        next(this.fsmState, Events.TIME_LOW, {
          script: this.script,
          questionIndex: this.questionIndex,
        });
        this.log.info("TIME_LOW");
      }
      if (left <= 0) {
        const r = next(this.fsmState, Events.TIME_UP, {
          script: this.script,
          questionIndex: this.questionIndex,
        });
        this.fsmState = r.state;
        this.log.info({ state: this.fsmState }, "TIME_UP");
      }
    }, 1000);

    const mode = process.env.AUDIO_OUT_MODE || "browser_injection";
    if (mode === "browser_injection") {
      await setupBrowserAudioSink(page);
    }

    await getOrCreateAudioBridge();
    const wsBase = `ws://127.0.0.1:${getBridgePort()}`;
    try {
      await injectMicCapture(page, {
        wsUrl: wsBase,
        sessionId: this.sessionId,
      });
    } catch (e) {
      this.log.warn({ err: String(e) }, "injectMicCapture failed");
    }

    const bridge = await getOrCreateAudioBridge();
    const frames = iteratePcmFrames(bridge, this.sessionId, this.sessionCancel);

    const rawSink = createAudioSink(mode, { page, slot: this.slot });
    const sink = {
      write: async (/** @type {Buffer} */ buf) => {
        if (buf.length && this._currentTurnFirstSinkMs == null) {
          this._currentTurnFirstSinkMs = Date.now();
        }
        return rawSink.write(buf);
      },
      flush: () => rawSink.flush(),
      close: rawSink.close?.bind(rawSink),
    };
    const pacer = new AudioPacer({ sink, cancel: this.sessionCancel });
    this._pacer = pacer;

    const sttGen = streamTranscribe(frames, {
      cancel: this.sessionCancel,
      sessionId: this.sessionId,
      onPartial: (t) => {
        if (t && t.length > 2) {
          this.interrupt.cancelActive();
          pacer.flush().catch(() => {});
        }
      },
    });

    try {
      await Promise.all([
        this.consumeStt(sttGen, ts),
        this.runInterview(page, pacer, ts),
      ]);
    } finally {
      this.sessionCancel.cancel();
      this.interrupt.cancelActive();
      await pacer.flush();
      pacer.stop();
      if (typeof rawSink.close === "function") await rawSink.close();
      if (this._timer) clearInterval(this._timer);
    }
  }

  /**
   * @param {AsyncGenerator<{ text: string, isFinal: boolean, vadSpeechEndMs?: number, sttFinalMs?: number }>} gen
   */
  async consumeStt(gen, ts) {
    for await (const seg of gen) {
      this.sessionCancel.throwIfCancelled();
      if (seg.isFinal && seg.text) {
        if (seg.vadSpeechEndMs != null && seg.sttFinalMs != null) {
          this._lastSttTiming = {
            vadSpeechEndMs: seg.vadSpeechEndMs,
            sttFinalMs: seg.sttFinalMs,
          };
        }
        this.memory.push("user", seg.text);
        await this.appendLine({
          speaker: "candidate",
          text: seg.text,
          time: ts(),
        });
      }
    }
  }

  /**
   * @param {import('playwright-core').Page} page
   * @param {AudioPacer} pacer
   */
  async runInterview(page, pacer, ts) {
    await this.speakTts(pacer, this.script.greeting, ts);
    this.fsmState = States.ASKING;

    for (let i = 0; i < this.script.questions.length; i++) {
      if (this.sessionCancel.cancelled || this.timeLeftSec() <= 0) break;
      this.questionIndex = i;
      const q = this.script.questions[i];
      await this.speakLlmTurn(pacer, ts, q);
      await new Promise((r) => setTimeout(r, 300));
    }

    await this.speakTts(pacer, this.script.closing, ts);
    this.fsmState = States.CLOSED;
    await leaveMeeting(page);
  }

  async speakTts(pacer, text, ts) {
    const turnId = ++this._turnId;
    this._currentTurnFirstSinkMs = null;
    const turn = this.interrupt.begin();
    await this.appendLine({ speaker: "agent", text, time: ts() });
    async function* once() {
      yield text;
    }
    let firstTtsMs = null;
    let ttsBytes = 0;
    for await (const pcm of streamSpeak({
      textIter: once(),
      cancel: turn,
      instructions: this.script.voiceInstructions,
    })) {
      if (firstTtsMs == null) firstTtsMs = Date.now();
      ttsBytes += pcm.length;
      await pacer.enqueue(pcm);
    }
    turn.cancel();
    const tAudioFirst =
      firstTtsMs != null && this._currentTurnFirstSinkMs != null
        ? this._currentTurnFirstSinkMs - firstTtsMs
        : null;
    this.log.info(
      {
        session_id: this.sessionId,
        turn_id: turnId,
        t_user_speech_end_ms: null,
        t_stt_final_ms: null,
        t_llm_first_token_ms: null,
        t_tts_first_chunk_ms: null,
        t_audio_first_frame_ms: tAudioFirst,
        t_e2e_ms: null,
        llm_total_tokens: 0,
        tts_total_bytes: ttsBytes,
      },
      "turn_latency"
    );
  }

  /**
   * @param {import('./interview/script').ScriptQuestion} q
   */
  async speakLlmTurn(pacer, ts, q) {
    const turnId = ++this._turnId;
    this._currentTurnFirstSinkMs = null;
    const sttSnap = this._lastSttTiming
      ? { ...this._lastSttTiming }
      : null;
    const turn = this.interrupt.begin();
    const system = buildSystemPrompt(
      this.script,
      States.ASKING,
      this.memory,
      this.timeLeftSec(),
      { questionIndex: this.questionIndex }
    );
    const messages = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Ask this interview question naturally in one short turn (≤2 sentences): ${q.text}`,
      },
    ];

    let llmFirstMs = null;
    let llmChars = 0;
    async function* textIter() {
      for await (const d of streamReply({ messages, cancel: turn })) {
        if (llmFirstMs == null) llmFirstMs = Date.now();
        llmChars += d.length;
        yield d;
      }
    }

    let firstTtsMs = null;
    let ttsBytes = 0;
    for await (const pcm of streamSpeak({
      textIter: textIter(),
      cancel: turn,
      instructions: this.script.voiceInstructions,
    })) {
      if (firstTtsMs == null) firstTtsMs = Date.now();
      ttsBytes += pcm.length;
      await pacer.enqueue(pcm);
    }
    turn.cancel();

    const vad = sttSnap?.vadSpeechEndMs ?? null;
    const sttFin = sttSnap?.sttFinalMs ?? null;
    const tSttFinal =
      vad != null && sttFin != null ? sttFin - vad : null;
    const tLlmFirst =
      sttFin != null && llmFirstMs != null ? llmFirstMs - sttFin : null;
    const tTtsFirst =
      llmFirstMs != null && firstTtsMs != null ? firstTtsMs - llmFirstMs : null;
    const tAudioFirst =
      firstTtsMs != null && this._currentTurnFirstSinkMs != null
        ? this._currentTurnFirstSinkMs - firstTtsMs
        : null;
    const tE2e =
      vad != null && this._currentTurnFirstSinkMs != null
        ? this._currentTurnFirstSinkMs - vad
        : null;

    this.log.info(
      {
        session_id: this.sessionId,
        turn_id: turnId,
        t_user_speech_end_ms: vad,
        t_stt_final_ms: tSttFinal,
        t_llm_first_token_ms: tLlmFirst,
        t_tts_first_chunk_ms: tTtsFirst,
        t_audio_first_frame_ms: tAudioFirst,
        t_e2e_ms: tE2e,
        llm_total_tokens: Math.ceil(llmChars / 4),
        tts_total_bytes: ttsBytes,
      },
      "turn_latency"
    );
  }
}

module.exports = { SessionWorker, InterruptController };
