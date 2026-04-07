const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SessionRegistry } = require("../src/backend/session_registry");
const metrics = require("../src/agent/metrics");

async function activeSessionsGaugeValue() {
  const text = await metrics.register.metrics();
  const m = text.match(/^nullxes_active_sessions (\d+)$/m);
  assert.ok(m, "expected nullxes_active_sessions gauge line in scrape");
  return Number(m[1]);
}

test("active_sessions gauge matches registry lifecycle (graceful + cleanup)", async () => {
  const baseline = await activeSessionsGaugeValue();
  const reg = new SessionRegistry();

  const id1 = "gauge-test-session-1";
  const worker1 = {
    slot: 0,
    gracefulShutdown: async () => {},
  };
  reg.set(id1, worker1);
  assert.equal(await activeSessionsGaugeValue(), baseline + 1);

  await worker1.gracefulShutdown();
  assert.ok(reg.releaseSession(id1, worker1.slot));
  assert.equal(await activeSessionsGaugeValue(), baseline);

  const id2 = "gauge-test-session-2";
  reg.set(id2, { slot: 1, gracefulShutdown: async () => {} });
  assert.equal(await activeSessionsGaugeValue(), baseline + 1);

  try {
    await Promise.reject(new Error("simulated run() failure"));
  } catch {
    /* intentional */
  } finally {
    assert.ok(reg.releaseSession(id2, 1));
  }
  assert.equal(await activeSessionsGaugeValue(), baseline);
});
