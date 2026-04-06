const { WebSocketServer } = require("ws");
const { EventEmitter } = require("events");

const FRAME_BYTES = 640;

/**
 * Browser connects with ?session=SESSION_ID and sends binary PCM16 16kHz frames.
 */
class AudioCaptureBridge extends EventEmitter {
  /**
   * @param {{ port: number, host?: string }} opts
   */
  constructor(opts) {
    super();
    this.port = opts.port;
    this.host = opts.host || "127.0.0.1";
    /** @type {import('ws').WebSocketServer | null} */
    this._wss = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._wss = new WebSocketServer({ host: this.host, port: this.port });
      this._wss.once("listening", () => resolve(undefined));
      this._wss.on("error", reject);
      this._wss.on("connection", (ws, req) => {
        const u = new URL(req.url || "", `http://${this.host}`);
        const sid = u.searchParams.get("session") || "default";
        this.emit("connection", sid);
        ws.on("message", (data) => {
          if (Buffer.isBuffer(data)) {
            this.emit("frame", sid, data);
          }
        });
        ws.on("close", () => {
          this.emit("disconnect", sid);
        });
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this._wss) {
        resolve(undefined);
        return;
      }
      this._wss.close(() => resolve(undefined));
    });
  }
}

/**
 * @param {AudioCaptureBridge} bridge
 * @param {string} sessionId
 * @param {import('./cancel').CancelToken} cancel
 */
async function* iteratePcmFrames(bridge, sessionId, cancel) {
  const queue = [];
  /** @type {((value: Buffer) => void) | null} */
  let wake = null;

  const onFrame = (sid, buf) => {
    if (sid !== sessionId) return;
    if (wake) {
      const w = wake;
      wake = null;
      w(buf);
    } else {
      queue.push(buf);
    }
  };

  bridge.on("frame", onFrame);
  try {
    while (!cancel.cancelled) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        const buf = await new Promise((r) => {
          wake = r;
        });
        yield buf;
      }
    }
  } finally {
    bridge.off("frame", onFrame);
  }
}

module.exports = { AudioCaptureBridge, iteratePcmFrames, FRAME_BYTES };
