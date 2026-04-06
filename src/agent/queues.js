/**
 * FIFO queue that drops the oldest item when at capacity (input overload).
 */
class DropOldestQueue {
  constructor(maxSize) {
    if (maxSize < 1) throw new Error("maxSize must be >= 1");
    this.maxSize = maxSize;
    this._items = [];
  }

  push(item) {
    this._items.push(item);
    while (this._items.length > this.maxSize) {
      this._items.shift();
    }
  }

  shift() {
    return this._items.shift();
  }

  peek() {
    return this._items[0];
  }

  get length() {
    return this._items.length;
  }

  clear() {
    this._items.length = 0;
  }
}

/**
 * FIFO queue; when full, async push() waits until space is available (back-pressure).
 */
class BoundedQueue {
  constructor(maxSize) {
    if (maxSize < 1) throw new Error("maxSize must be >= 1");
    this.maxSize = maxSize;
    this._items = [];
    /** @type {(() => void)[]} */
    this._pushWaiters = [];
  }

  /**
   * @param {unknown} item
   * @returns {Promise<void>}
   */
  push(item) {
    return new Promise((resolve) => {
      if (this._items.length < this.maxSize) {
        this._items.push(item);
        resolve();
        return;
      }
      this._pushWaiters.push(() => {
        this._items.push(item);
        resolve();
      });
    });
  }

  shift() {
    const v = this._items.shift();
    const w = this._pushWaiters.shift();
    if (w) w();
    return v;
  }

  peek() {
    return this._items[0];
  }

  get length() {
    return this._items.length;
  }

  clear() {
    const freed = this._items.length;
    this._items.length = 0;
    let slots = freed;
    while (slots > 0 && this._pushWaiters.length > 0) {
      const w = this._pushWaiters.shift();
      if (w) {
        w();
        slots -= 1;
      }
    }
  }
}

module.exports = { DropOldestQueue, BoundedQueue };
