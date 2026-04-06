const { randomUUID } = require("crypto");

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
  }

  newSessionId() {
    return randomUUID();
  }

  unregister(id) {
    this.sessions.delete(id);
  }

  get(id) {
    return this.sessions.get(id);
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionRegistry };
