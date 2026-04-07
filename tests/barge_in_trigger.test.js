const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  FRAME_BYTES,
  segmentUtterances,
} = require("../src/agent/audio_utterance_segmenter");
const { CancelToken } = require("../src/agent/cancel");

function silentFrame() {
  return Buffer.alloc(FRAME_BYTES, 0);
}

function loudFrame() {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) {
    b.writeInt16LE(16000, i);
  }
  return b;
}

test("onSpeechStart fires exactly once at speech start, before first utterance yield", async () => {
  process.env.OPENAI_STT_VAD_RMS_THRESHOLD = "0.05";
  process.env.OPENAI_STT_SILENCE_MS = "100";
  process.env.OPENAI_STT_MIN_UTTERANCE_MS = "60";
  process.env.OPENAI_STT_MAX_UTTERANCE_MS = "60000";

  const cancel = new CancelToken();
  const order = [];
  let startCount = 0;

  async function* frames() {
    for (let i = 0; i < 10; i++) yield silentFrame();
    for (let i = 0; i < 10; i++) yield loudFrame();
    for (let i = 0; i < 20; i++) yield silentFrame();
  }

  const chunks = [];
  for await (const u of segmentUtterances(frames(), {
    cancel,
    onSpeechStart: () => {
      startCount += 1;
      order.push("start");
    },
  })) {
    order.push("yield");
    chunks.push(u);
  }

  assert.equal(startCount, 1);
  assert.ok(order[0] === "start", "speech start must precede first yield");
  const firstYieldIdx = order.indexOf("yield");
  assert.ok(firstYieldIdx > 0);
  assert.ok(order.slice(0, firstYieldIdx).every((e) => e === "start"));
  assert.ok(chunks.length >= 1);
});
