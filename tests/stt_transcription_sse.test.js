const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  interpretTranscriptionStreamEvent,
  appendSseChunk,
} = require("../src/agent/stt_transcription_sse");
const { processSseDataLine } = require("../src/agent/stt_openai");

test("interpretTranscriptionStreamEvent accumulates delta and finalizes done", () => {
  const state = { accumulated: "" };
  const a = interpretTranscriptionStreamEvent(
    { type: "transcript.text.delta", delta: "Hel" },
    state
  );
  assert.equal(a.kind, "partial");
  assert.equal(a.text, "Hel");
  const b = interpretTranscriptionStreamEvent(
    { type: "transcript.text.delta", delta: "lo" },
    state
  );
  assert.equal(b.kind, "partial");
  assert.equal(b.text, "Hello");
  const c = interpretTranscriptionStreamEvent(
    { type: "transcript.text.done", text: "Hello" },
    state
  );
  assert.equal(c.kind, "final");
  assert.equal(c.text, "Hello");
  assert.equal(state.accumulated, "");
});

test("appendSseChunk splits CRLF and preserves incomplete line", () => {
  const r1 = appendSseChunk("", 'data: {"x":1}\r\n');
  assert.deepEqual(r1.lines, ['data: {"x":1}']);
  assert.equal(r1.carry, "");
  const r2 = appendSseChunk("", 'data: {"y"');
  const r3 = appendSseChunk(r2.carry, ':2}\n');
  assert.ok(r3.lines.some((l) => l.includes('"y"')));
});

test("processSseDataLine yields partial and final", () => {
  const state = { accumulated: "" };
  const log = { warn() {} };
  const p1 = [
    ...processSseDataLine(
      'data: {"type":"transcript.text.delta","delta":"a"}',
      state,
      null,
      log
    ),
  ];
  assert.equal(p1.length, 1);
  assert.equal(p1[0].isFinal, false);
  assert.equal(p1[0].text, "a");
  const p2 = [
    ...processSseDataLine(
      'data: {"type":"transcript.text.done","text":"a"}',
      state,
      null,
      log
    ),
  ];
  assert.equal(p2.length, 1);
  assert.equal(p2[0].isFinal, true);
  assert.equal(p2[0].text, "a");
});
