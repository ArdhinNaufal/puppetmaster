import assert from "node:assert/strict";
import { InlineRunner } from "../packages/kernel/dist/queue.js";

let releaseSlow;
const slow = new Promise((resolve) => {
  releaseSlow = resolve;
});
const dispatched = [];
const runner = new InlineRunner(async (missionId) => {
  dispatched.push(missionId);
  if (missionId === "slow") await slow;
  return missionId;
});

await runner.start();
await runner.enqueue("slow");
await runner.enqueue("fast");
await Promise.resolve();
assert.deepEqual(dispatched, ["slow", "fast"]);

let closeSettled = false;
const closing = runner.close().then(() => {
  closeSettled = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(closeSettled, false, "close() returned before the active dispatch drained");
await assert.rejects(
  runner.enqueue("late"),
  /inline workflow runner is closing/,
  "enqueue() must reject once close begins",
);

releaseSlow();
await closing;
assert.equal(closeSettled, true);
await runner.close();
await assert.rejects(runner.start(), /inline workflow runner is closing/);

console.log("RUNNER LIFECYCLE PASS: inline dispatch drain/close guard/idempotent close");
