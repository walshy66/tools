import test from "node:test";
import assert from "node:assert/strict";
import { IntegrationError, integrateTask } from "./integration.mjs";

const task = {
  id: "task-005",
  fileScope: [{ path: "src", type: "directory" }],
  verification: ["node --test"],
};
const taskWorktree = { path: "/managed/task-005", branch: "crosby/task-005", baseSha: "base" };
const parentWorktree = { path: "/managed/parent", branch: "crosby/parent" };

function operations(overrides = {}) {
  const calls = [];
  return {
    calls,
    collectChangedPaths: async () => { calls.push("paths"); return ["src/feature.mjs"]; },
    validateChangedPaths: (paths, scopes) => { calls.push(["scope", paths, scopes]); return { valid: true }; },
    runTaskVerification: async () => { calls.push("verify"); return { skipped: false, results: [{ code: 0 }] }; },
    safeCommit: async () => { calls.push("commit"); return { committed: true, sha: "task-sha" }; },
    serializedMerge: async () => { calls.push("merge"); return { merged: true, sha: "parent-sha" }; },
    retainTaskFailure: ({ reason }) => ({ outcome: "review-required", recoveryNotes: [reason] }),
    ...overrides,
  };
}

test("validates, verifies, commits, and merges a task serially into the parent", async () => {
  const ops = operations();
  const result = await integrateTask({ task, taskWorktree, parentWorktree, operations: ops });

  assert.deepEqual(ops.calls.map((entry) => typeof entry === "string" ? entry : entry[0]), ["paths", "scope", "verify", "commit", "merge"]);
  assert.equal(result.merge.merged, true);
});

test("retains task evidence and does not merge when verification fails", async () => {
  const ops = operations({
    runTaskVerification: async () => { ops.calls.push("verify"); throw new Error("tests failed"); },
  });
  await assert.rejects(
    integrateTask({ task, taskWorktree, parentWorktree, operations: ops }),
    (error) => error instanceof IntegrationError && /tests failed/.test(error.message) && error.retained.outcome === "review-required",
  );
  assert.deepEqual(ops.calls, ["paths", ["scope", ["src/feature.mjs"], task.fileScope], "verify"]);
});

test("retains task evidence when changed paths escape the declared scope", async () => {
  const ops = operations({
    collectChangedPaths: async () => { ops.calls.push("paths"); return ["docs/outside.md"]; },
    validateChangedPaths: () => { ops.calls.push("scope"); throw new Error("outside scope"); },
  });
  await assert.rejects(() => integrateTask({ task, taskWorktree, parentWorktree, operations: ops }), /outside scope/);
  assert.deepEqual(ops.calls, ["paths", "scope"]);
});
