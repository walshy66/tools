import assert from "node:assert/strict";
import {
  buildRalphLoopPrompt,
  runSingleChildExecution,
  selectNextRunnableChild,
} from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

function makeQueue(parentState = "Triage") {
  return {
    parent: {
      identifier: "COA-116",
      title: "The Crosby Loop",
      state: { name: parentState },
    },
    children: [
      {
        identifier: "COA-122",
        title: "Already building",
        priority: 0,
        state: { name: "Building" },
        relations: { blockedBy: [], blocks: [] },
      },
      {
        identifier: "COA-121",
        title: "Blocked child",
        priority: 0,
        state: { name: "Build Ready" },
        relations: { blockedBy: [{ identifier: "COA-120", state: { name: "Build Ready" } }], blocks: [] },
      },
      {
        identifier: "COA-120",
        title: "First runnable child",
        priority: 1,
        state: { name: "Build Ready" },
        relations: { blockedBy: [], blocks: [] },
      },
      {
        identifier: "COA-123",
        title: "Second runnable child",
        priority: 2,
        state: { name: "Build Ready" },
        relations: { blockedBy: [], blocks: [] },
      },
    ],
  };
}

const workerPrompt = buildRalphLoopPrompt("COA-120");
assert.ok(workerPrompt.startsWith("/skill:ralph-loop COA-120\n"));
assert.match(workerPrompt, /Return JSON only with this schema:/);

const selected = selectNextRunnableChild(makeQueue());
assert.equal(selected.child.identifier, "COA-120", "Should claim the first deterministic runnable child");
assert.deepEqual(selected.classification.reasonSummary, {
  blocked: ["COA-121"],
  building: ["COA-122"],
});

const calls = [];
const result = await runSingleChildExecution(makeQueue(), {
  async moveIssue(issueKey, state) {
    calls.push(["moveIssue", issueKey, state]);
  },
  async runWorker({ parentIssueKey, childIssueKey, prompt }) {
    calls.push(["runWorker", parentIssueKey, childIssueKey, prompt]);
    return {
      code: 0,
      stdout: JSON.stringify({
        issueKey: "COA-120",
        issueTitle: "First runnable child",
        outcome: "done",
        summary: "Completed the child",
        changes: ["claimed runnable child"],
        tests: ["verify-crosby-claim-and-worker.mjs"],
      }),
    };
  },
});

assert.equal(result.child.identifier, "COA-120");
assert.ok(result.workerPrompt.startsWith("/skill:ralph-loop COA-120\n"));
assert.equal(result.movedParentToBuilding, true);
assert.deepEqual(calls, [
  ["moveIssue", "COA-120", "Building"],
  ["moveIssue", "COA-116", "Building"],
  ["runWorker", "COA-116", "COA-120", result.workerPrompt],
  ["moveIssue", "COA-120", "Done"],
]);

const alreadyBuildingCalls = [];
const alreadyBuildingResult = await runSingleChildExecution(makeQueue("Building"), {
  async moveIssue(issueKey, state) {
    alreadyBuildingCalls.push(["moveIssue", issueKey, state]);
  },
  async runWorker({ childIssueKey, prompt }) {
    alreadyBuildingCalls.push(["runWorker", childIssueKey, prompt]);
    return {
      code: 0,
      stdout: JSON.stringify({
        issueKey: "COA-120",
        issueTitle: "First runnable child",
        outcome: "done",
        summary: "Completed the child",
        changes: ["claimed runnable child"],
        tests: ["verify-crosby-claim-and-worker.mjs"],
      }),
    };
  },
});

assert.equal(alreadyBuildingResult.movedParentToBuilding, false);
assert.deepEqual(alreadyBuildingCalls, [
  ["moveIssue", "COA-120", "Building"],
  ["runWorker", "COA-120", alreadyBuildingResult.workerPrompt],
  ["moveIssue", "COA-120", "Done"],
]);

await assert.rejects(
  () =>
    runSingleChildExecution(
      {
        parent: { identifier: "COA-116", state: { name: "Triage" } },
        children: [
          {
            identifier: "COA-122",
            title: "Already building",
            priority: 0,
            state: { name: "Building" },
            relations: { blockedBy: [], blocks: [] },
          },
        ],
      },
      {
        async moveIssue() {
          throw new Error("should not be called");
        },
        async runWorker() {
          throw new Error("should not be called");
        },
      },
    ),
  /no runnable child issues/i,
);

console.log("PASS: /crosby claims one runnable child, updates Building state, and launches an isolated Ralph Loop worker");
