/**
 * Inject TTS PCM into Zoom via Web Audio: MediaStreamDestination + getUserMedia hook.
 * PCM pushed here is **16 kHz mono s16le** — must match `tts_openai.js` after resample
 * (API returns 24 kHz; `streamSpeak` resamples to 16 kHz before frames hit the pacer).
 * WebRTC may resample the MediaStream for transport; the graph runs at SR below.
 *
 * Must run via addInitScript before the first navigation.
 */

const INJECT_MARK = "__nullxesAudioInjected";

/** Playback sample rate — keep aligned with `src/agent/tts_openai.js` OUT_SR. */
const INJECT_SR = 16000;

const INJECT_SNIPPET = `(() => {
  if (window.${INJECT_MARK}) return;
  window.${INJECT_MARK} = true;

  const FRAME_SAMPLES = 320;
  const SR = ${INJECT_SR};
  const ctx = new AudioContext({ sampleRate: SR });
  window.__nullxesAudioCtx = ctx;
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  gain.connect(dest);
  let playHead = 0;
  let scheduled = 0;
  const maxQueued = 200;
  /** @type {Set<AudioBufferSourceNode>} */
  const activeSources = new Set();

  function armResumeOnGesture() {
    const resume = () => {
      if (ctx.state === "suspended") ctx.resume().catch(function () {});
    };
    document.addEventListener("click", resume, { once: true, capture: true });
    document.addEventListener("keydown", resume, { once: true, capture: true });
    document.addEventListener("pointerdown", resume, { once: true, capture: true });
  }
  armResumeOnGesture();

  function scheduleChunk(int16) {
    if (scheduled > maxQueued) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      f32[i] = int16[i] / 32768;
    }
    const buf = ctx.createBuffer(1, f32.length, SR);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const t = Math.max(ctx.currentTime, playHead);
    src.start(t);
    playHead = t + buf.duration;
    scheduled++;
    activeSources.add(src);
    src.onended = function () {
      scheduled--;
      activeSources.delete(src);
    };
  }

  window.__nullxesPushPCM = function (b64) {
    if (ctx.state !== "running") {
      ctx.resume().catch(function () {});
    }
    const bin = atob(b64);
    const len = bin.length;
    if (len < 2 || len % 2 !== 0) return;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
    for (let o = 0; o < int16.length; o += FRAME_SAMPLES) {
      const end = Math.min(o + FRAME_SAMPLES, int16.length);
      scheduleChunk(int16.subarray(o, end));
    }
  };

  window.__nullxesFlushAudio = function () {
    for (const s of activeSources) {
      try {
        s.stop(0);
      } catch (e) {}
    }
    activeSources.clear();
    playHead = ctx.currentTime;
    scheduled = 0;
  };

  window.__nullxesGetMicStream = function () {
    return dest.stream;
  };

  /** When true, getUserMedia passes through to the real device (STT capture in injectMicCapture). */
  window.__nullxesBypassFakeMic = false;

  function patchGetUserMedia() {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") return false;
    if (md.getUserMedia.__nullxesPatched) return true;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const c = constraints || {};
      const wantAudio = !!c.audio;
      const wantVideo = !!c.video;
      if (wantAudio && !window.__nullxesBypassFakeMic) {
        if (wantVideo) {
          const vStream = await orig({ video: c.video, audio: false });
          const aTrack = dest.stream.getAudioTracks()[0];
          const tracks = [aTrack, ...vStream.getVideoTracks()].filter(Boolean);
          return new MediaStream(tracks);
        }
        return dest.stream;
      }
      return orig(constraints);
    };
    md.getUserMedia.__nullxesPatched = true;
    window.__nullxesOrigGetUserMedia = orig;
    return true;
  }

  if (!patchGetUserMedia()) {
    const start = Date.now();
    const t = setInterval(function () {
      if (patchGetUserMedia() || Date.now() - start > 5000) clearInterval(t);
    }, 10);
  }
})();
`;

/**
 * Register init script only (runs before page JS, including Zoom's getUserMedia).
 *
 * @param {import('playwright-core').Page} page
 */
async function setupBrowserAudioSink(page) {
  await page.addInitScript(INJECT_SNIPPET);
}

/**
 * @param {{ page: import('playwright-core').Page }} ctx
 */
class BrowserAudioSink {
  constructor(ctx) {
    this.page = ctx.page;
  }

  /**
   * @param {Buffer} pcm16Buffer
   */
  async write(pcm16Buffer) {
    if (pcm16Buffer.length === 0) return;
    const b64 = pcm16Buffer.toString("base64");
    await this.page.evaluate(
      (b) => {
        if (typeof window.__nullxesPushPCM === "function") {
          window.__nullxesPushPCM(b);
        }
      },
      b64
    );
  }

  async flush() {
    await this.page.evaluate(() => {
      if (typeof window.__nullxesFlushAudio === "function") {
        window.__nullxesFlushAudio();
      }
    });
  }

  async close() {
    /* page may close first */
  }
}

module.exports = {
  BrowserAudioSink,
  setupBrowserAudioSink,
  INJECT_SNIPPET,
  INJECT_SR,
};
