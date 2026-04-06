/**
 * Dev path: inject PCM into Zoom via Web Audio in-page (no PulseAudio).
 * Requires setupBrowserAudioSink(page) once after navigation.
 */

const INJECT_MARK = "__nullxesAudioInjected";

const INJECT_SNIPPET = `(() => {
  if (window.${INJECT_MARK}) return;
  window.${INJECT_MARK} = true;
  const FRAME_SAMPLES = 320;
  const SR = 16000;
  const ctx = new AudioContext({ sampleRate: SR });
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  gain.connect(dest);
  let playHead = 0;
  let scheduled = 0;
  const maxQueued = 200;

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
    src.onended = () => { scheduled--; };
  }

  window.__nullxesPushPCM = function (b64) {
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
    playHead = ctx.currentTime;
    scheduled = 0;
  };

  window.__nullxesGetMicStream = function () {
    return dest.stream;
  };
})();
`;

/**
 * @param {import('playwright-core').Page} page
 */
async function setupBrowserAudioSink(page) {
  await page.addInitScript(INJECT_SNIPPET);
  await page.evaluate(INJECT_SNIPPET);
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
};
