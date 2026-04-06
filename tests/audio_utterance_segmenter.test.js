const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  frameRmsNorm,
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

test("frameRmsNorm: silence near zero, tone above threshold", () => {
  assert.ok(frameRmsNorm(silentFrame()) < 0.001);
  assert.ok(frameRmsNorm(loudFrame()) > 0.2);
});

test("segmentUtterances yields one buffer after speech + silence", async () => {
  process.env.OPENAI_STT_VAD_RMS_THRESHOLD = "0.05";
  process.env.OPENAI_STT_SILENCE_MS = "100";
  process.env.OPENAI_STT_MIN_UTTERANCE_MS = "60";
  process.env.OPENAI_STT_MAX_UTTERANCE_MS = "60000";

  async function* frames() {
    for (let i = 0; i < 10; i++) yield loudFrame();
    for (let i = 0; i < 20; i++) yield silentFrame();
  }

  const cancel = new CancelToken();
  const chunks = [];
  for await (const u of segmentUtterances(frames(), cancel)) {
    chunks.push(u);
  }
  assert.ok(chunks.length >= 1);
  assert.ok(chunks[0].length >= 6 * FRAME_BYTES);
});
