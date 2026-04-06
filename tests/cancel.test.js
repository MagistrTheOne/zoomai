const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CancelToken } = require("../src/agent/cancel");

async function* fakeLlm(cancel) {
  for (let i = 0; i < 100; i++) {
    cancel.throwIfCancelled();
    yield `a${i}`;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function* chain(cancel) {
  for await (const x of fakeLlm(cancel)) {
    yield x;
  }
}

test("CancelToken stops fake LLM chain within one delta window", async () => {
  const c = new CancelToken();
  const out = [];
  const task = (async () => {
    try {
      for await (const x of chain(c)) {
        out.push(x);
        if (out.length >= 2) c.cancel();
      }
    } catch (e) {
      if (e.code !== "CANCELLED") throw e;
    }
  })();
  await task;
  assert.ok(out.length <= 3);
});
