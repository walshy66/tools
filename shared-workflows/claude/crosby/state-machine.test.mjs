import test from "node:test";
import assert from "node:assert/strict";
import { StateTransitionError, transitionQueue } from "./state-machine.mjs";

test("allows the queue to advance only through valid durable states", () => {
  const initial = { queueState: "ready", currentTask: null };
  const running = transitionQueue(initial, "start", { taskId: "task-001" });
  assert.deepEqual(running, { queueState: "working", currentTask: "task-001" });

  const complete = transitionQueue(running, "complete", { taskId: "task-001" });
  assert.deepEqual(complete, { queueState: "ready", currentTask: null });
});

test("rejects completion for a task other than the current worker", () => {
  assert.throws(
    () => transitionQueue({ queueState: "working", currentTask: "task-001" }, "complete", { taskId: "task-002" }),
    StateTransitionError,
  );
});

test("blocked and failed outcomes stop the queue", () => {
  for (const outcome of ["blocked", "failed", "cancelled"]) {
    assert.equal(
      transitionQueue({ queueState: "working", currentTask: "task-001" }, outcome, { taskId: "task-001" }).queueState,
      outcome,
    );
  }
});
