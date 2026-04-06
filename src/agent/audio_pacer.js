const FRAME_MS = 20;
const FRAME_BYTES = 640;

/**
 * Pulls PCM16 frames and writes to sink at 20 ms wall-clock cadence.
 */
class AudioPacer {
  /**
   * @param {{ sink: { write: (b: Buffer) => void | Promise<void>, flush: () => void | Promise<void> }, cancel: import('./cancel').CancelToken }} opts
   */
  constructor(opts) {
    this.sink = opts.sink;
    this.cancel = opts.cancel;
    /** @type {Buffer} */
    this._pending = Buffer.alloc(0);
    /** @type {ReturnType<typeof setInterval> | null} */
    this._interval = null;
  }

  _ensureTick() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      this._tick().catch(() => {});
    }, FRAME_MS);
  }

  async _tick() {
    if (this.cancel.cancelled) {
      if (this._interval) clearInterval(this._interval);
      this._interval = null;
      return;
    }
    if (this._pending.length < FRAME_BYTES) return;
    const frame = this._pending.subarray(0, FRAME_BYTES);
    this._pending = this._pending.subarray(FRAME_BYTES);
    const w = this.sink.write(Buffer.from(frame));
    if (w && typeof w.then === "function") await w;
  }

  /**
   * @param {Buffer} pcmChunk
   */
  async enqueue(pcmChunk) {
    this._pending = Buffer.concat([this._pending, pcmChunk]);
    this._ensureTick();
  }

  async flush() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._pending = Buffer.alloc(0);
    const f = this.sink.flush();
    if (f && typeof f.then === "function") await f;
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }
}

module.exports = { AudioPacer, FRAME_BYTES, FRAME_MS };
