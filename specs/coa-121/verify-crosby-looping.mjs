import assert from "node:assert/strict";
import { buildParentProgressComment, runQueueExecution } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

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

const queueSnapshots = [
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Triage" } },
    children: [
      makeChild("COA-120", "First runnable child", "Build Ready", { priority: 1 }),
      makeChild("COA-121", "Blocked child", "Build Ready", {
        priority: 0,
        blockedBy: [{ identifier: "COA-119", state: { name: "Building" } }],
      }),
      makeChild("COA-122", "Review child", "Review"),
      makeChild("COA-123", "Second runnable child", "Build Ready", { priority: 2 }),
    ],
  },
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Building" } },
    children: [
      makeChild("COA-120", "First runnable child", "Done", { priority: 1 }),
      makeChild("COA-121", "Blocked child", "Build Ready", {
        priority: 0,
        blockedBy: [{ identifier: "COA-119", state: { name: "Building" } }],
      }),
      makeChild("COA-122", "Review child", "Review"),
      makeChild("COA-123", "Second runnable child", "Build Ready", { priority: 2 }),
    ],
  },
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Building" } },
    children: [
      makeChild("COA-120", "First runnable child", "Done", { priority: 1 }),
      makeChild("COA-121", "Blocked child", "Build Ready", {
        priority: 0,
        blockedBy: [{ identifier: "COA-119", state: { name: "Building" } }],
      }),
      makeChild("COA-122", "Review child", "Review"),
      makeChild("COA-123", "Second runnable child", "Done", { priority: 2 }),
    ],
  },
];

const calls = [];
let refreshIndex = 1;
const result = await runQueueExecution(queueSnapshots[0], {
  async moveIssue(issueKey, state) {
    calls.push(["moveIssue", issueKey, state]);
  },
  async addComment(issueKey, body) {
    calls.push(["addComment", issueKey, body]);
  },
  async runWorker({ childIssueKey, prompt }) {
    calls.push(["runWorker", childIssueKey, prompt]);
    return {
      code: 0,
      stdout: JSON.stringify({
        issueKey: childIssueKey,
        issueTitle: childIssueKey === "COA-120" ? "First runnable child" : "Second runnable child",
        outcome: "done",
        summary: `Completed ${childIssueKey}`,
        changes: [`implemented ${childIssueKey}`],
        tests: [`verified ${childIssueKey}`],
      }),
    };
  },
  async refreshQueue(parentIssueKey) {
    calls.push(["refreshQueue", parentIssueKey]);
    return queueSnapshots[refreshIndex++];
  },
});

assert.deepEqual(
  result.completedChildren.map((entry) => entry.child.identifier),
  ["COA-120", "COA-123"],
  "Queue should continue through all runnable children",
);
assert.equal(result.movedParentToBuilding, true);
assert.deepEqual(result.remainingByReason, {
  blocked: ["COA-121"],
  review: ["COA-122"],
});
assert.deepEqual(calls, [
  ["moveIssue", "COA-120", "Building"],
  ["moveIssue", "COA-116", "Building"],
  ["runWorker", "COA-120", result.completedChildren[0].workerPrompt],
  ["moveIssue", "COA-120", "Done"],
  ["addComment", "COA-116", buildParentProgressComment(result.completedChildren[0])],
  ["refreshQueue", "COA-116"],
  ["moveIssue", "COA-123", "Building"],
  ["runWorker", "COA-123", result.completedChildren[1].workerPrompt],
  ["moveIssue", "COA-123", "Done"],
  ["addComment", "COA-116", buildParentProgressComment(result.completedChildren[1])],
  ["refreshQueue", "COA-116"],
]);

const noRunnable = await runQueueExecution(
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Building" } },
    children: [
      makeChild("COA-121", "Blocked child", "Build Ready", {
        blockedBy: [{ identifier: "COA-119", state: { name: "Building" } }],
      }),
      makeChild("COA-122", "Review child", "Review"),
    ],
  },
  {
    async moveIssue() {
      throw new Error("should not move issues when nothing is runnable");
    },
    async addComment() {
      throw new Error("should not add comments when nothing is runnable");
    },
    async runWorker() {
      throw new Error("should not run worker when nothing is runnable");
    },
    async refreshQueue() {
      throw new Error("should not refresh queue when nothing is runnable");
    },
  },
);

assert.equal(noRunnable.completedChildren.length, 0);
assert.deepEqual(noRunnable.remainingByReason, {
  blocked: ["COA-121"],
  review: ["COA-122"],
});

console.log("PASS: /crosby refreshes queue after each child, keeps running runnable children, and stops with grouped remaining summary");
