import assert from "node:assert/strict";
import { parseCrosbyCommandArgs, runWatchMode } from "../../shared-workflows/pi/extensions/crosby/lib.mjs";

function makeChild(identifier, title, extra = {}) {
  return {
    identifier,
    title,
    priority: extra.priority ?? 1,
    state: { name: extra.state ?? "Ready to Build", type: extra.stateType ?? "unstarted" },
    relations: {
      blockedBy: extra.blockedBy ?? [],
      blocks: extra.blocks ?? [],
    },
    labels: extra.labels ?? { nodes: [] },
  };
}

function makeExecuteParent(identifier, title, children, extra = {}) {
  return {
    parent: {
      identifier,
      title,
      priority: extra.priority ?? 1,
      state: { name: extra.state ?? "Execute", type: extra.stateType ?? "started" },
      labels: extra.labels ?? { nodes: [] },
      branchName: extra.branchName ?? "test/branch",
      comments: { nodes: [] },
    },
    children,
  };
}

assert.deepEqual(parseCrosbyCommandArgs("--watch"), { mode: "watch" });
assert.deepEqual(parseCrosbyCommandArgs("COA-129"), { mode: "parent", issueKey: "COA-129" });

const snapshots = [
  [
    makeExecuteParent("COA-129", "Symphony", [makeChild("COA-201", "First queued issue", { priority: 1 })], { priority: 1 }),
    makeExecuteParent("COA-130", "Second parent", [makeChild("COA-202", "Second queued issue", { priority: 2 })], { priority: 2 }),
  ],
  [makeExecuteParent("COA-130", "Second parent", [makeChild("COA-202", "Second queued issue", { priority: 2 })], { priority: 2 })],
  [],
];

const queueByParent = new Map(
  snapshots.flat().map((queue) => [queue.parent.identifier, queue]),
);

let fetchIndex = 0;
const calls = [];
const result = await runWatchMode(
  {
    async fetchExecuteParentQueues() {
      calls.push(["fetchExecuteParentQueues", fetchIndex]);
      return snapshots[fetchIndex++] ?? [];
    },
    async moveIssue(issueKey, state) {
      calls.push(["moveIssue", issueKey, state]);
    },
    async addComment(issueKey) {
      calls.push(["addComment", issueKey]);
    },
    async refreshQueue(parentIssueKey) {
      calls.push(["refreshQueue", parentIssueKey]);
      const queue = queueByParent.get(parentIssueKey);
      return {
        ...queue,
        children: (queue?.children ?? []).map((child) => ({
          ...child,
          state: { name: "Done", type: "completed" },
        })),
      };
    },
    async finalizeParentCompletion(queue) {
      calls.push(["finalizeParentCompletion", queue.parent.identifier]);
    },
    async runWorker({ childIssueKey, prompt }) {
      calls.push(["runWorker", childIssueKey, prompt]);
      return {
        code: 0,
        stdout: JSON.stringify({
          issueKey: childIssueKey,
          issueTitle: childIssueKey === "COA-201" ? "First queued issue" : "Second queued issue",
          outcome: "done",
          summary: `Completed ${childIssueKey}`,
          changes: [`implemented ${childIssueKey}`],
          tests: [`verified ${childIssueKey}`],
        }),
      };
    },
    async sleep(ms) {
      calls.push(["sleep", ms]);
    },
  },
  {
    pollIntervalMs: 25,
    maxCycles: 3,
  },
);

assert.deepEqual(result.cycles.map((cycle) => cycle.status), ["processed", "processed", "idle"]);
assert.equal(result.cycles[0].parent.identifier, "COA-129");
assert.equal(result.cycles[0].issue.identifier, "COA-201");
assert.equal(result.cycles[1].parent.identifier, "COA-130");
assert.equal(result.cycles[1].issue.identifier, "COA-202");
assert.equal(result.cycles[2].issue, null);
assert.deepEqual(calls, [
  ["fetchExecuteParentQueues", 0],
  ["moveIssue", "COA-201", "Building"],
  ["runWorker", "COA-201", result.cycles[0].workerPrompt],
  ["moveIssue", "COA-201", "Done"],
  ["addComment", "COA-129"],
  ["refreshQueue", "COA-129"],
  ["finalizeParentCompletion", "COA-129"],
  ["sleep", 25],
  ["fetchExecuteParentQueues", 1],
  ["moveIssue", "COA-202", "Building"],
  ["runWorker", "COA-202", result.cycles[1].workerPrompt],
  ["moveIssue", "COA-202", "Done"],
  ["addComment", "COA-130"],
  ["refreshQueue", "COA-130"],
  ["finalizeParentCompletion", "COA-130"],
  ["sleep", 25],
  ["fetchExecuteParentQueues", 2],
]);

console.log("PASS: /crosby --watch polls parent issues in Execute, dispatches Ready to Build children one at a time, and idles cleanly when no runnable parent queue remains");
