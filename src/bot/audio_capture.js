/**
 * Injects microphone capture in the Zoom page and streams PCM16 mono 16 kHz to a local WebSocket.
 * @param {import('playwright-core').Page} page
 * @param {{ wsUrl: string, sessionId: string }} opts
 */
async function injectMicCapture(page, opts) {
  const { wsUrl, sessionId } = opts;
  const fullUrl = `${wsUrl}?session=${encodeURIComponent(sessionId)}`;

  await page.evaluate(
    async ({ url }) => {
      const TARGET_SR = 16000;
      const FRAME_SAMPLES = 320;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        ws.onopen = () => resolve(undefined);
        ws.onerror = () => reject(new Error("ws error"));
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const bufferSize = 4096;
      const proc = ctx.createScriptProcessor(bufferSize, 1, 1);
      let carry = new Float32Array(0);
      const downsample = (input, inputRate, outputRate) => {
        if (inputRate === outputRate) return input;
        const ratio = inputRate / outputRate;
        const outLen = Math.floor(input.length / ratio);
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          out[i] = input[Math.floor(i * ratio)];
        }
        return out;
      };
      const floatToPcm16 = (f32) => {
        const buf = new ArrayBuffer(f32.length * 2);
        const v = new DataView(buf);
        for (let i = 0; i < f32.length; i++) {
          let s = Math.max(-1, Math.min(1, f32[i]));
          v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return new Uint8Array(buf);
      };
      proc.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const f32 = downsample(input, ctx.sampleRate, TARGET_SR);
        const merged = new Float32Array(carry.length + f32.length);
        merged.set(carry, 0);
        merged.set(f32, carry.length);
        let offset = 0;
        while (offset + FRAME_SAMPLES <= merged.length) {
          const chunk = merged.subarray(offset, offset + FRAME_SAMPLES);
          offset += FRAME_SAMPLES;
          ws.send(floatToPcm16(chunk));
        }
        carry = merged.slice(offset);
      };
      source.connect(proc);
      proc.connect(ctx.destination);
    },
    { url: fullUrl }
  );
}

module.exports = { injectMicCapture };
