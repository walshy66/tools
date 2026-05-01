import assert from "node:assert/strict";
import { runSingleChildExecution } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

function makeQueue(parentState = "Building") {
  return {
    parent: {
      identifier: "COA-116",
      title: "The Crosby Loop",
      state: { name: parentState },
    },
    children: [
      {
        identifier: "COA-120",
        title: "Implement worker result contract and terminal child outcomes",
        priority: 1,
        state: { name: "Build Ready" },
        relations: { blockedBy: [], blocks: [] },
      },
    ],
  };
}

function makeWorkerStdout(outcome, extra = {}) {
  return JSON.stringify({
    issueKey: "COA-120",
    issueTitle: "Implement worker result contract and terminal child outcomes",
    outcome,
    summary: "Handled the child outcome",
    changes: ["updated worker handling"],
    tests: ["node --test specs/coa-120/verify-crosby-worker-results.mjs"],
    ...extra,
  });
}

const doneCalls = [];
const doneResult = await runSingleChildExecution(makeQueue(), {
  async moveIssue(issueKey, state) {
    doneCalls.push(["moveIssue", issueKey, state]);
  },
  async runWorker({ childIssueKey, prompt }) {
    doneCalls.push(["runWorker", childIssueKey, prompt]);
    return { code: 0, stdout: makeWorkerStdout("done") };
  },
});

assert.equal(doneResult.workerResult.outcome, "done");
assert.ok(doneResult.workerPrompt.startsWith("/skill:ralph-loop COA-120\n"));
assert.deepEqual(doneCalls, [
  ["moveIssue", "COA-120", "Building"],
  ["runWorker", "COA-120", doneResult.workerPrompt],
  ["moveIssue", "COA-120", "Done"],
]);

const reviewCalls = [];
const reviewResult = await runSingleChildExecution(makeQueue(), {
  async moveIssue(issueKey, state) {
    reviewCalls.push(["moveIssue", issueKey, state]);
  },
  async runWorker({ childIssueKey, prompt }) {
    reviewCalls.push(["runWorker", childIssueKey, prompt]);
    return {
      code: 0,
      stdout: makeWorkerStdout("review", {
        requiredHumanAction: "Check the blocked dependency before rerunning.",
        recoveryNotes: ["Child needs human follow-up."],
      }),
    };
  },
});

assert.equal(reviewResult.workerResult.outcome, "review");
assert.equal(reviewResult.workerResult.requiredHumanAction, "Check the blocked dependency before rerunning.");
assert.deepEqual(reviewCalls, [
  ["moveIssue", "COA-120", "Building"],
  ["runWorker", "COA-120", reviewResult.workerPrompt],
  ["moveIssue", "COA-120", "Review"],
]);

const fatalCalls = [];
const fatalResult = await runSingleChildExecution(makeQueue(), {
  async moveIssue(issueKey, state) {
    fatalCalls.push(["moveIssue", issueKey, state]);
  },
  async runWorker({ childIssueKey, prompt }) {
    fatalCalls.push(["runWorker", childIssueKey, prompt]);
    return {
      code: 0,
      stdout: makeWorkerStdout("fatal", {
        requiredHumanAction: "Inspect the child issue before retrying.",
        recoveryNotes: ["Worker could not persist final child status."],
      }),
    };
  },
});

assert.equal(fatalResult.workerResult.outcome, "fatal");
assert.equal(fatalResult.workerResult.recoveryNotes[0], "Worker could not persist final child status.");
assert.deepEqual(fatalCalls, [
  ["moveIssue", "COA-120", "Building"],
  ["runWorker", "COA-120", fatalResult.workerPrompt],
]);

await assert.rejects(
  () =>
    runSingleChildExecution(makeQueue(), {
      async moveIssue() {},
      async runWorker() {
        return { code: 0, stdout: "worker complete" };
      },
    }),
  /structured worker result/i,
);

console.log("PASS: /crosby handles structured worker outcomes for done, review, fatal, and malformed results");
