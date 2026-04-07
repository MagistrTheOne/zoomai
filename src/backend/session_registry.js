const { randomUUID } = require("crypto");
const metrics = require("../agent/metrics");

class SessionRegistry {
  constructor() {
    /** @type {Map<string, import('../agent/session_worker').SessionWorker>} */
    this.sessions = new Map();
    /** @type {Set<number>} */
    this.freeSlots = new Set();
    this.max = Number(process.env.MAX_CONCURRENT_SESSIONS || 10);
    for (let i = 0; i < this.max; i++) {
      this.freeSlots.add(i);
    }
  }

  allocateSlot() {
    const [slot] = this.freeSlots;
    if (slot === undefined) return null;
    this.freeSlots.delete(slot);
    return slot;
  }

  releaseSlot(slot) {
    this.freeSlots.add(slot);
  }

  /**
   * @param {string} id
   * @param {import('../agent/session_worker').SessionWorker} worker
   */
  set(id, worker) {
    this.sessions.set(id, worker);
    metrics.activeSessions.inc();
  }

  newSessionId() {
    return randomUUID();
  }

  /**
   * @param {string} id
   * @returns {boolean} true if a session was removed
   */
  unregister(id) {
    const removed = this.sessions.delete(id);
    if (removed) metrics.activeSessions.dec();
    return removed;
  }

  /**
   * Single exit path: unregister (dec gauge) + release slot. Safe to call
   * from run().finally, DELETE .finally, or shutdown — second call is a no-op.
   * @param {string} id
   * @param {number} slot
   * @returns {boolean} true if the session was removed this call
   */
  releaseSession(id, slot) {
    const removed = this.unregister(id);
    if (removed) this.releaseSlot(slot);
    return removed;
  }

  get(id) {
    return this.sessions.get(id);
  }

  get size() {
    return this.sessions.size;
  }

  /** @returns {import('../agent/session_worker').SessionWorker[]} */
  listAll() {
    return [...this.sessions.values()];
  }
}

module.exports = { SessionRegistry };
