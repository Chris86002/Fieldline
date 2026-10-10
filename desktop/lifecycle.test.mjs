import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForServer } from "./lifecycle.mjs";

function child() {
  const process = new EventEmitter();
  process.killed = false;
  process.kill = () => { process.killed = true; };
  return process;
}

test("ready signal clears startup listeners", async () => {
  const process = child();
  const ready = waitForServer(process, 100);
  process.emit("message", { type: "ready" });
  await ready;
  assert.equal(process.listenerCount("exit"), 0);
  assert.equal(process.killed, false);
});

for (const reason of ["EADDRINUSE", "START_FAILED", "SERVER_EXITED", "START_TIMEOUT"]) {
  test(`${reason} rejects startup and kills the child without changing origin`, async () => {
    const process = child();
    const ready = waitForServer(process, reason === "START_TIMEOUT" ? 5 : 100);
    if (reason === "SERVER_EXITED") process.emit("exit", 1);
    else if (reason !== "START_TIMEOUT") process.emit("message", { type: "error", code: reason });
    await assert.rejects(ready, new RegExp(reason));
    assert.equal(process.killed, true);
    assert.equal(process.listenerCount("message"), 0);
  });
}
