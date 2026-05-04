import test from "node:test";
import assert from "node:assert/strict";
import { finalizeParentAfterReview, runWatchCycle, runWatchMode } from "./lib-v2.mjs";

test("runWatchCycle keeps fatal worker issues in Build and does not move them to review", async () => {
  const moved = [];
  const result = await runWatchCycle({
    fetchExecuteIssues: async () => [
      {
        identifier: "COA-135",
        title: "Failure handling and daemon resilience",
        state: { name: "Execute", type: "started" },
        parent: { identifier: "COA-129", title: "Symphony" },
      },
    ],
    moveIssue: async (issueKey, state) => moved.push([issueKey, state]),
    runWorker: async () => ({
      stdout: JSON.stringify({
        issueKey: "COA-135",
        issueTitle: "Failure handling and daemon resilience",
        outcome: "fatal",
        summary: "Worker failed safely.",
        changes: ["Logged the failure"],
        tests: ["Simulated worker failure"],
        requiredHumanAction: "Inspect the worker failure.",
        recoveryNotes: ["Fix the worker, then rerun watch mode."],
      }),
    }),
  });

  assert.equal(result.status, "fatal");
  assert.deepEqual(moved, [["COA-135", "Building"]]);
  assert.equal(result.workerResult.outcome, "fatal");
});

test("runWatchMode continues polling after a fatal worker result", async () => {
  const moved = [];
  let cycleCount = 0;

  const result = await runWatchMode(
    {
      fetchExecuteIssues: async () => {
        cycleCount += 1;
        return cycleCount === 1
          ? [
              {
                identifier: "COA-135",
                title: "Failure handling and daemon resilience",
                state: { name: "Execute", type: "started" },
                parent: { identifier: "COA-129", title: "Symphony" },
              },
            ]
          : [
              {
                identifier: "COA-136",
                title: "Next issue",
                state: { name: "Execute", type: "started" },
                parent: { identifier: "COA-129", title: "Symphony" },
              },
            ];
      },
      moveIssue: async (issueKey, state) => moved.push([issueKey, state]),
      runWorker: async ({ childIssueKey }) => ({
        stdout: JSON.stringify(
          childIssueKey === "COA-135"
            ? {
                issueKey: "COA-135",
                issueTitle: "Failure handling and daemon resilience",
                outcome: "fatal",
                summary: "Worker failed safely.",
                changes: ["Logged the failure"],
                tests: ["Simulated worker failure"],
                requiredHumanAction: "Inspect the worker failure.",
                recoveryNotes: ["Fix the worker, then rerun watch mode."],
              }
            : {
                issueKey: "COA-136",
                issueTitle: "Next issue",
                outcome: "done",
                summary: "Worker succeeded.",
                changes: ["Completed the issue"],
                tests: ["Simulated worker success"],
              },
        ),
      }),
      sleep: async () => {},
    },
    {
      maxCycles: 2,
      pollIntervalMs: 0,
      getNow: (() => {
        const timestamps = [new Date("2026-05-04T00:02:00Z"), new Date("2026-05-04T08:00:00Z")];
        let index = 0;
        return () => timestamps[index++] ?? timestamps[timestamps.length - 1];
      })(),
    },
  );

  assert.equal(result.cycles.length, 2);
  assert.equal(result.cycles[0].status, "fatal");
  assert.equal(result.cycles[1].status, "processed");
  assert.deepEqual(moved, [
    ["COA-135", "Building"],
    ["COA-136", "Building"],
    ["COA-136", "In Review"],
  ]);
});

test("finalizeParentAfterReview still moves parent to review and comments when Claude review fails", async () => {
  const calls = [];
  await finalizeParentAfterReview(
    {
      parent: {
        identifier: "COA-129",
        title: "Symphony",
        branchName: "test-branch",
        labels: { nodes: [{ name: "tools" }] },
      },
      children: [
        { identifier: "COA-135", title: "Failure handling and daemon resilience", state: { name: "Done" } },
      ],
    },
    [
      {
        child: { identifier: "COA-135", title: "Failure handling and daemon resilience" },
        workerResult: {
          outcome: "done",
          summary: "Completed.",
          changes: ["Added resilience handling"],
          tests: ["node --test lib-v2.test.mjs"],
          recoveryNotes: [],
        },
      },
    ],
    {
      routing: { documentsRoot: "C:/Users/camer/Documents", projectsRoot: "C:/Users/camer/Documents/projects", folderExists: (p) => /tools$/i.test(p) },
      getPullRequest: async () => ({ number: 42, url: "https://example.com/pr/42", body: "Existing body", headRefName: "test-branch" }),
      readImplementationSummary: async () => "Summary details",
      updatePullRequest: async (payload) => calls.push(["updatePullRequest", payload.body]),
      runClaudeReview: async () => {
        throw new Error("Claude crashed");
      },
      addPullRequestComment: async (payload) => calls.push(["addPullRequestComment", payload.body]),
      addParentComment: async (issueKey, body) => calls.push(["addParentComment", issueKey, body]),
      moveParentToReview: async (issueKey, state) => calls.push(["moveParentToReview", issueKey, state]),
    },
  );

  assert.equal(calls.at(-1)[0], "moveParentToReview");
  assert.match(calls.find(([type]) => type === "addPullRequestComment")[1], /Review failed/);
  assert.match(calls.find(([type]) => type === "addPullRequestComment")[1], /Claude crashed/);
});

test("runWatchMode completes the next cycle after a large sleep/wake time jump", async () => {
  const cycles = [];
  const result = await runWatchMode(
    {
      fetchReadyToBuildIssues: async () => [
        { identifier: "COA-200", title: "Ready issue", state: { name: "Ready to Build" } },
      ],
      fetchExecuteIssues: async () => [],
      moveIssue: async () => {},
      runWorker: async () => {
        throw new Error("should not run");
      },
      sleep: async () => {},
    },
    {
      maxCycles: 2,
      pollIntervalMs: 0,
      lastSweepDateKey: "2026-05-03",
      getNow: (() => {
        const timestamps = [new Date("2026-05-04T00:02:00Z"), new Date("2026-05-04T12:45:00Z")];
        let index = 0;
        return () => timestamps[index++] ?? timestamps[timestamps.length - 1];
      })(),
      onCycle: async (cycle) => cycles.push(cycle),
    },
  );

  assert.equal(result.cycles.length, 2);
  assert.equal(cycles[0].sweep.ran, true);
  assert.deepEqual(cycles[0].sweep.movedIssueKeys, ["COA-200"]);
  assert.equal(cycles[1].status, "idle");
});
