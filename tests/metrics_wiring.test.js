const { test } = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../src/agent/metrics");

test("metrics registry scrape includes observed histogram with non-zero count", async () => {
  metrics.e2eLatency.observe(450);
  const text = await metrics.register.metrics();
  assert.ok(text.includes("nullxes_e2e_latency_ms"));
  const m = text.match(/nullxes_e2e_latency_ms_count\s+(\d+)/);
  assert.ok(m, "expected histogram _count line");
  assert.ok(Number(m[1]) >= 1, "expected non-zero sample count");
});
