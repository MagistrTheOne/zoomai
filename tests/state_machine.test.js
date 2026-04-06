const { test } = require("node:test");
const assert = require("node:assert/strict");
const { States, Events, next } = require("../src/agent/interview/state_machine");

const script = {
  vacancy: "X",
  greeting: "g",
  closing: "c",
  time_budget_seconds: 100,
  persona_style: "p",
  questions: [{ id: "q1", text: "t1" }],
};

const ctx = { script, questionIndex: 0 };

test("GREETING + AGENT_DONE -> ASKING", () => {
  const r = next(States.GREETING, Events.AGENT_DONE_SPEAKING, ctx);
  assert.equal(r.state, States.ASKING);
});

test("TIME_UP -> WRAPPING_UP", () => {
  const r = next(States.ASKING, Events.TIME_UP, ctx);
  assert.equal(r.state, States.WRAPPING_UP);
});

test("BARGE_IN -> LISTENING", () => {
  const r = next(States.ASKING, Events.BARGE_IN, ctx);
  assert.equal(r.state, States.LISTENING);
});

test("TIME_LOW shortens (action)", () => {
  const r = next(States.LISTENING, Events.TIME_LOW, ctx);
  assert.equal(r.action, "shorten_replies");
});

test("WRAPPING_UP + AGENT_DONE -> CLOSED", () => {
  const r = next(States.WRAPPING_UP, Events.AGENT_DONE_SPEAKING, ctx);
  assert.equal(r.state, States.CLOSED);
});
