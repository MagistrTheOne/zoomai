const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { mkdirSync } = require("fs");
const path = require("path");
const { tmpdir } = require("os");
const { createControlRouter } = require("../src/backend/control_server");
const { SessionRegistry } = require("../src/backend/session_registry");

test("DELETE /sessions/:id returns 202 immediately and invokes gracefulShutdown in background", async () => {
  const transcriptsDir = path.join(tmpdir(), `tx-grace-${Date.now()}`);
  mkdirSync(transcriptsDir, { recursive: true });

  const sessionRegistry = new SessionRegistry();
  const id = "test-del-session";
  let shutdownCalled = false;
  const mockWorker = {
    gracefulShutdown: async (reason) => {
      shutdownCalled = true;
      assert.equal(reason, "operator_stop");
    },
    slot: 0,
  };
  sessionRegistry.set(id, mockWorker);

  const { router } = createControlRouter({ sessionRegistry, transcriptsDir });
  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/sessions/${id}`, {
    method: "DELETE",
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.deepEqual(body, { status: "shutting_down" });

  await new Promise((r) => setImmediate(r));
  assert.ok(shutdownCalled, "gracefulShutdown should have been scheduled");

  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});
