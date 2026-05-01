import assert from "node:assert/strict";
import { runQueueExecution, runSingleChildExecution } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

function makeChild(identifier, title, state, extra = {}) {
  return {
    identifier,
    title,
    priority: extra.priority ?? 1,
    state: { name: state },
    relations: {
      blockedBy: extra.blockedBy ?? [],
      blocks: extra.blocks ?? [],
    },
  };
}

function makeQueue(parentState = "Triage", children = []) {
  return {
    parent: {
      identifier: "COA-116",
      title: "The Crosby Loop",
      state: { name: parentState },
      comments: { nodes: [] },
    },
    children,
  };
}

await assert.rejects(
  () =>
    runQueueExecution(
      makeQueue("Building", [
        makeChild("COA-120", "Already claimed child", "Building"),
        makeChild("COA-123", "Still runnable child", "Build Ready", { priority: 2 }),
      ]),
      {
        async moveIssue() {
          throw new Error("should not move issues when another supervisor is active");
        },
        async addComment() {
          throw new Error("should not add comments when another supervisor is active");
        },
        async runWorker() {
          throw new Error("should not start a worker when another supervisor is active");
        },
        async refreshQueue() {
          throw new Error("should not refresh when another supervisor is active at startup");
        },
      },
    ),
  /another active supervisor run is already in progress/i,
);

const raceCalls = [];
await assert.rejects(
  () =>
    runQueueExecution(
      makeQueue("Triage", [
        makeChild("COA-123", "First runnable child", "Build Ready", { priority: 1 }),
        makeChild("COA-124", "Second runnable child", "Build Ready", { priority: 2 }),
      ]),
      {
        async moveIssue(issueKey, state) {
          raceCalls.push(["moveIssue", issueKey, state]);
          if (issueKey === "COA-123" && state === "Building") {
            throw new Error("Linear returned a stale update error");
          }
        },
        async addComment() {
          raceCalls.push(["addComment"]);
        },
        async runWorker() {
          raceCalls.push(["runWorker"]);
          throw new Error("worker should not run after a raced claim");
        },
        async refreshQueue(parentIssueKey) {
          raceCalls.push(["refreshQueue", parentIssueKey]);
          return makeQueue("Building", [
            makeChild("COA-123", "First runnable child", "Building", { priority: 1 }),
            makeChild("COA-124", "Second runnable child", "Build Ready", { priority: 2 }),
          ]);
        },
      },
    ),
  /another active supervisor run is already in progress/i,
);
assert.deepEqual(raceCalls, [
  ["moveIssue", "COA-123", "Building"],
  ["refreshQueue", "COA-116"],
]);

const childTransitionCalls = [];
await assert.rejects(
  () =>
    runSingleChildExecution(
      makeQueue("Building", [makeChild("COA-123", "Runnable child", "Build Ready")]),
      {
        async moveIssue(issueKey, state) {
          childTransitionCalls.push(["moveIssue", issueKey, state]);
          throw new Error("Linear mutation failed");
        },
        async runWorker() {
          childTransitionCalls.push(["runWorker"]);
          throw new Error("worker should not run when child claim fails");
        },
      },
    ),
  /failed to move child issue COA-123 to Building/i,
);
assert.deepEqual(childTransitionCalls, [["moveIssue", "COA-123", "Building"]]);

const parentTransitionCalls = [];
await assert.rejects(
  () =>
    runSingleChildExecution(
      makeQueue("Triage", [makeChild("COA-123", "Runnable child", "Build Ready")]),
      {
        async moveIssue(issueKey, state) {
          parentTransitionCalls.push(["moveIssue", issueKey, state]);
          if (issueKey === "COA-116") {
            throw new Error("Parent mutation failed");
          }
        },
        async runWorker() {
          parentTransitionCalls.push(["runWorker"]);
          throw new Error("worker should not run when parent transition fails");
        },
      },
    ),
  /failed to move parent issue COA-116 to Building/i,
);
assert.deepEqual(parentTransitionCalls, [
  ["moveIssue", "COA-123", "Building"],
  ["moveIssue", "COA-116", "Building"],
]);

const finalizationQueue = [
  makeQueue("Building", [makeChild("COA-123", "Runnable child", "Build Ready")]),
  makeQueue("Building", [makeChild("COA-123", "Runnable child", "Done")]),
];
let finalizationRefreshes = 0;
await assert.rejects(
  () =>
    runQueueExecution(finalizationQueue[0], {
      async moveIssue() {},
      async addComment(issueKey, body) {
        if (body.includes("final summary")) {
          throw new Error("Linear summary mutation failed");
        }
      },
      async runWorker() {
        return {
          code: 0,
          stdout: JSON.stringify({
            issueKey: "COA-123",
            issueTitle: "Runnable child",
            outcome: "done",
            summary: "Completed COA-123",
            changes: ["implemented COA-123"],
            tests: ["node specs/coa-123/verify-crosby-concurrency-and-failure-handling.mjs"],
          }),
        };
      },
      async refreshQueue() {
        return finalizationQueue[++finalizationRefreshes];
      },
    }),
  /failed to post final parent summary comment/i,
);

console.log("PASS: /crosby fails closed for concurrent supervisors and reports Linear mutation failures clearly");
