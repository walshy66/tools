import assert from "node:assert/strict";
import {
  buildFinalParentSummary,
  buildParentProgressComment,
  runQueueExecution,
} from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

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

const doneExecution = {
  child: makeChild("COA-122", "Post parent progress comments", "Done"),
  workerResult: {
    outcome: "done",
    summary: "Posted the parent progress comment",
    changes: ["added per-child parent reporting"],
    tests: ["node specs/coa-122/verify-crosby-parent-reporting.mjs"],
    recoveryNotes: [],
  },
};

const reviewExecution = {
  child: makeChild("COA-122", "Post parent progress comments", "Review"),
  workerResult: {
    outcome: "review",
    summary: "Needs human help before finalization",
    changes: ["captured review outcome"],
    tests: ["node specs/coa-122/verify-crosby-parent-reporting.mjs"],
    requiredHumanAction: "Review the failed mutation in Linear.",
    recoveryNotes: ["Parent finalization is blocked until the child is completed."],
  },
};

assert.match(buildParentProgressComment(doneExecution), /COA-122 — Post parent progress comments/);
assert.match(buildParentProgressComment(doneExecution), /Status: Done/);
assert.match(buildParentProgressComment(doneExecution), /Key changes:\n- added per-child parent reporting/);
assert.match(buildParentProgressComment(reviewExecution), /Status: Review/);
assert.match(buildParentProgressComment(reviewExecution), /Follow-up notes \/ risks:\n- Review the failed mutation in Linear\.\n- Parent finalization is blocked until the child is completed\./);

const queueSnapshots = [
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Building" }, comments: { nodes: [] } },
    children: [
      makeChild("COA-120", "First child", "Build Ready", { priority: 1 }),
      makeChild("COA-121", "Second child", "Build Ready", { priority: 2 }),
    ],
  },
  {
    parent: {
      identifier: "COA-116",
      title: "The Crosby Loop",
      state: { name: "Building" },
      comments: {
        nodes: [{ body: "COA-120 — First child\n\nStatus: Done\n\nSummary: Completed COA-120\n\nKey changes:\n- implemented COA-120\n\nTests/verifications:\n- verified COA-120\n\nFollow-up notes / risks:\n- None." }],
      },
    },
    children: [
      makeChild("COA-120", "First child", "Done", { priority: 1 }),
      makeChild("COA-121", "Second child", "Build Ready", { priority: 2 }),
    ],
  },
  {
    parent: {
      identifier: "COA-116",
      title: "The Crosby Loop",
      state: { name: "Building" },
      comments: {
        nodes: [{ body: "COA-120 — First child\n\nStatus: Done\n\nSummary: Completed COA-120\n\nKey changes:\n- implemented COA-120\n\nTests/verifications:\n- verified COA-120\n\nFollow-up notes / risks:\n- None." }],
      },
    },
    children: [
      makeChild("COA-120", "First child", "Done", { priority: 1 }),
      makeChild("COA-121", "Second child", "Done", { priority: 2 }),
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
  async runWorker({ childIssueKey }) {
    calls.push(["runWorker", childIssueKey]);
    return {
      code: 0,
      stdout: JSON.stringify({
        issueKey: childIssueKey,
        issueTitle: childIssueKey === "COA-120" ? "First child" : "Second child",
        outcome: "done",
        summary: `Completed ${childIssueKey}`,
        changes: [`implemented ${childIssueKey}`],
        tests: [`verified ${childIssueKey}`],
      }),
    };
  },
  async refreshQueue() {
    calls.push(["refreshQueue"]);
    return queueSnapshots[refreshIndex++];
  },
});

assert.deepEqual(result.completedChildren.map((entry) => entry.child.identifier), ["COA-120", "COA-121"]);
assert.equal(calls.filter(([name]) => name === "addComment").length, 3, "two progress comments plus final parent summary");
assert.deepEqual(calls.slice(0, 5), [
  ["moveIssue", "COA-120", "Building"],
  ["runWorker", "COA-120"],
  ["moveIssue", "COA-120", "Done"],
  ["addComment", "COA-116", buildParentProgressComment(result.completedChildren[0])],
  ["refreshQueue"],
]);
assert.deepEqual(calls.slice(5), [
  ["moveIssue", "COA-121", "Building"],
  ["runWorker", "COA-121"],
  ["moveIssue", "COA-121", "Done"],
  ["addComment", "COA-116", buildParentProgressComment(result.completedChildren[1])],
  ["refreshQueue"],
  ["addComment", "COA-116", buildFinalParentSummary(queueSnapshots[2], result.completedChildren)],
  ["moveIssue", "COA-116", "Review"],
]);

const reviewQueue = await runQueueExecution(
  {
    parent: { identifier: "COA-116", title: "The Crosby Loop", state: { name: "Building" }, comments: { nodes: [] } },
    children: [makeChild("COA-122", "Review child", "Review")],
  },
  {
    async moveIssue() {
      throw new Error("should not move anything");
    },
    async addComment() {
      throw new Error("should not add final comment when no runnable child exists");
    },
    async runWorker() {
      throw new Error("should not run worker");
    },
    async refreshQueue() {
      throw new Error("should not refresh queue");
    },
  },
);
assert.deepEqual(reviewQueue.remainingByReason, { review: ["COA-122"] });

await assert.rejects(
  () =>
    runQueueExecution(queueSnapshots[0], {
      async moveIssue() {},
      async addComment() {
        throw new Error("Linear comment failed");
      },
      async runWorker({ childIssueKey }) {
        return {
          code: 0,
          stdout: JSON.stringify({
            issueKey: childIssueKey,
            issueTitle: "First child",
            outcome: "done",
            summary: "Completed COA-120",
            changes: ["implemented COA-120"],
            tests: ["verified COA-120"],
          }),
        };
      },
      async refreshQueue() {
        return queueSnapshots[1];
      },
    }),
  /Failed to post required parent progress comment/i,
);

console.log("PASS: /crosby posts parent progress comments, finalizes the parent only when all children are done, and fails closed on reporting errors");
