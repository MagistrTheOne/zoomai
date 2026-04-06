/**
 * Cooperative cancellation for streaming pipelines (STT → LLM → TTS → pacer).
 */
class CancelToken {
  constructor() {
    this._cancelled = false;
    this._listeners = new Set();
  }

  get cancelled() {
    return this._cancelled;
  }

  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const fn of this._listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this._listeners.clear();
  }

  /**
   * @param {() => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (this._cancelled) {
      fn();
      return () => {};
    }
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  throwIfCancelled() {
    if (this._cancelled) {
      const err = new Error("cancelled");
      err.code = "CANCELLED";
      throw err;
    }
  }
}

module.exports = { CancelToken };
