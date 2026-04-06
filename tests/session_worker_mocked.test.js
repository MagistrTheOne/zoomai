const { test } = require("node:test");
const assert = require("node:assert/strict");
const { States, Events, next } = require("../src/agent/interview/state_machine");
const { loadScript } = require("../src/agent/interview/script");
const path = require("path");

test("script loads and FSM reaches CLOSED after WRAPPING_UP", () => {
  const sp = path.join(
    __dirname,
    "..",
    "examples",
    "interview_backend_dev.yaml"
  );
  const script = loadScript(sp);
  assert.ok(script.questions.length >= 6);

  const ctx = { script, questionIndex: 0 };
  let r = next(States.GREETING, Events.AGENT_DONE_SPEAKING, ctx);
  assert.equal(r.state, States.ASKING);
  r = next(States.WRAPPING_UP, Events.AGENT_DONE_SPEAKING, ctx);
  assert.equal(r.state, States.CLOSED);
});
