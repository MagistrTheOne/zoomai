const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AudioPacer } = require("../src/agent/audio_pacer");
const { CancelToken } = require("../src/agent/cancel");

test("pacer flush completes within 40ms", async () => {
  const cancel = new CancelToken();
  const frames = [];
  const sink = {
    write: (b) => {
      frames.push(b);
    },
    flush: () => {},
  };
  const pacer = new AudioPacer({ sink, cancel });
  const buf = Buffer.alloc(640, 7);
  await pacer.enqueue(buf);
  const t0 = Date.now();
  await pacer.flush();
  const dt = Date.now() - t0;
  assert.ok(dt <= 40, `flush took ${dt}ms`);
  pacer.stop();
});
