const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CancelToken } = require("../src/agent/cancel");
const { DropOldestQueue, BoundedQueue } = require("../src/agent/queues");

test("CancelToken cancel and throwIfCancelled", () => {
  const c = new CancelToken();
  assert.equal(c.cancelled, false);
  c.cancel();
  assert.equal(c.cancelled, true);
  assert.throws(() => c.throwIfCancelled(), (e) => e.code === "CANCELLED");
});

test("CancelToken subscribe fires if already cancelled", () => {
  const c = new CancelToken();
  c.cancel();
  let n = 0;
  c.subscribe(() => {
    n += 1;
  });
  assert.equal(n, 1);
});

test("DropOldestQueue drops oldest", () => {
  const q = new DropOldestQueue(2);
  q.push(1);
  q.push(2);
  q.push(3);
  assert.equal(q.shift(), 2);
  assert.equal(q.shift(), 3);
});

test("BoundedQueue blocks then unblocks on shift", async () => {
  const q = new BoundedQueue(2);
  await q.push("a");
  await q.push("b");
  const p = q.push("c");
  assert.equal(q.length, 2);
  q.shift();
  await p;
  assert.equal(q.length, 2);
  assert.equal(q.shift(), "b");
  assert.equal(q.shift(), "c");
});
