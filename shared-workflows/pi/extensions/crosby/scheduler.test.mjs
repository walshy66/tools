import test from "node:test";
import assert from "node:assert/strict";
import {
  createVisibleWorkerScheduler,
  VisibleWorkerLaunchError,
  VisibleWorkerRecoveryError,
  workerReportToExecutionResult,
  selectGlobalWorkerCandidates,
  integrateWorkerReport,
  runFinalIntegrationChecks,
  createCrosbySupervisor,
} from "./scheduler.mjs";

function harness({ existingWorker, inspectError, startError, promptError } = {}) {
  const calls = [];
  const registry = { workers: existingWorker ? { "COA-365": structuredClone(existingWorker) } : {} };
  const store = { root: "/registry", repositoryIdentity: "repo", parentKey: "COA-360" };
  const herdr = {
    async inspectAgent({ agent }) {
      calls.push(["inspectAgent", agent]);
      if (inspectError) throw inspectError;
      return { name: agent, state: "working" };
    },
    async createTaskTab(input) {
      calls.push(["createTaskTab", input]);
      return { workspace: input.workspace, tab: "tab-365", pane: "pane-365" };
    },
    async startPiAgent(input) {
      calls.push(["startPiAgent", input]);
      if (startError) throw startError;
      return { name: input.name, pane: input.pane, state: "working" };
    },
    async promptAgent(input) {
      calls.push(["promptAgent", input]);
      if (promptError) throw promptError;
      return { state: "working" };
    },
    async closeTaskTab(input) {
      calls.push(["closeTaskTab", input]);
      return { tab: input.tab };
    },
    async waitForAgent(input) {
      calls.push(["waitForAgent", input]);
      return { state: "done" };
    },
    async readAgent(input) {
      calls.push(["readAgent", input]);
      return {
        text: JSON.stringify({
          outcome: "complete",
          taskOutcome: "done",
          summary: "Completed work.",
          changes: { paths: ["in-scope.txt"], commit: "abc123" },
          verification: [{ command: "node --test", result: "passed" }],
          risks: [],
        }),
      };
    },
  };
  const scheduler = createVisibleWorkerScheduler({
    registryRoot: "/registry",
    herdr,
    createRegistryStore: () => store,
    readRegistry: async () => structuredClone(registry),
    updateWorkerRecord: async (_store, key, patch) => {
      registry.workers[key] = { ...(registry.workers[key] ?? {}), ...structuredClone(patch) };
      return registry.workers[key];
    },
    recordWorkerRecovery: async (_store, key, note) => {
      const worker = registry.workers[key];
      if (worker.recoveryAttempts >= 1) throw new Error("one automatic same-worktree recovery");
      registry.workers[key] = {
        ...worker,
        lifecycle: "launching",
        recoveryAttempts: (worker.recoveryAttempts ?? 0) + 1,
        recoveryNotes: [...(worker.recoveryNotes ?? []), note],
      };
      return registry.workers[key];
    },
    createManagedRepository: async (input) => {
      calls.push(["createManagedRepository", input]);
      return { barePath: "/managed/source.git" };
    },
    createParentWorktree: async (input) => {
      calls.push(["createParentWorktree", input]);
      return { path: "/managed/COA-360/parent", branch: "feature/coa-360", baseSha: "parent-sha" };
    },
    createTaskWorktree: async (input) => {
      calls.push(["createTaskWorktree", input]);
      return { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" };
    },
  });
  return { scheduler, registry, calls };
}

const parent = { identifier: "COA-360", branchName: "feature/coa-360" };
const child = { identifier: "COA-365" };

const launchInput = {
  parent,
  child,
  prompt: "Return the worker report.",
  sourcePath: "/project",
  repositoryIdentity: "repo",
  workspace: "workspace-1",
};

test("claims a task, creates a visible tab, starts Pi, and persists Herdr identifiers", async () => {
  const { scheduler, registry, calls } = harness();

  const result = await scheduler.launch(launchInput);

  assert.equal(result.adopted, false);
  assert.deepEqual(registry.workers["COA-365"], {
    lifecycle: "running",
    attemptCount: 1,
    task: { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" },
    parentWorktree: { path: "/managed/COA-360/parent", branch: "feature/coa-360", baseSha: "parent-sha" },
    herdr: { workspace: "workspace-1", tab: "tab-365", pane: "pane-365", agent: "crosby-coa-365" },
  });
  assert.deepEqual(calls.slice(-3), [
    ["createTaskTab", { workspace: "workspace-1", label: "COA-365", cwd: "/managed/COA-360/tasks/COA-365", focus: false }],
    ["startPiAgent", { pane: "pane-365", name: "crosby-coa-365" }],
    ["promptAgent", { agent: "crosby-coa-365", prompt: "Return the worker report.", wait: false }],
  ]);
});

test("closes a partially started worker and retains launch evidence when Herdr startup fails", async () => {
  const { scheduler, registry, calls } = harness({ promptError: new Error("prompt failed") });

  await assert.rejects(() => scheduler.launch(launchInput), VisibleWorkerLaunchError);

  assert.deepEqual(calls.at(-1), ["closeTaskTab", { tab: "tab-365" }]);
  assert.equal(registry.workers["COA-365"].lifecycle, "launch-failed");
  assert.deepEqual(registry.workers["COA-365"].herdr, { workspace: "workspace-1", tab: "tab-365", pane: "pane-365", agent: "crosby-coa-365" });
  assert.match(registry.workers["COA-365"].launchError, /prompt failed/);
});

test("waits for and validates the worker's explicit structured report", async () => {
  const { scheduler, calls } = harness();

  const report = await scheduler.waitForReport({ herdr: { agent: "crosby-coa-365" } });

  assert.equal(report.outcome, "complete");
  assert.deepEqual(calls, [
    ["waitForAgent", { agent: "crosby-coa-365", until: ["idle", "done", "blocked"] }],
    ["readAgent", { agent: "crosby-coa-365", lines: 2000 }],
  ]);
});

test("maps explicit worker reports to the existing Crosby child outcome contract", () => {
  const result = workerReportToExecutionResult(
    {
      outcome: "blocked",
      summary: "Need a decision.",
      requiredHumanAction: "Choose the migration path.",
      recoveryNotes: ["Resume after the decision."],
      requestHerdrBlocked: true,
    },
    { identifier: "COA-365", title: "Launch and recover a visible Herdr Crosby worker" },
  );

  assert.deepEqual(result, {
    issueKey: "COA-365",
    issueTitle: "Launch and recover a visible Herdr Crosby worker",
    outcome: "review",
    summary: "Need a decision.",
    changes: [],
    tests: [],
    requiredHumanAction: "Choose the migration path.",
    recoveryNotes: ["Resume after the decision."],
  });
});

test("adopts an existing recorded Herdr worker after restart without launching a duplicate", async () => {
  const existingWorker = {
    lifecycle: "running",
    attemptCount: 1,
    task: { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" },
    herdr: { workspace: "workspace-1", tab: "tab-old", pane: "pane-old", agent: "crosby-coa-365" },
  };
  const { scheduler, calls } = harness({ existingWorker });

  const result = await scheduler.launch(launchInput);

  assert.equal(result.adopted, true);
  assert.deepEqual(calls, [["inspectAgent", "crosby-coa-365"]]);
});

test("requires review when the one same-worktree recovery cannot start", async () => {
  const existingWorker = {
    lifecycle: "running",
    attemptCount: 1,
    recoveryAttempts: 0,
    task: { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" },
    herdr: { workspace: "workspace-1", tab: "tab-old", pane: "pane-old", agent: "crosby-coa-365" },
  };
  const { scheduler, registry } = harness({
    existingWorker,
    inspectError: new Error("agent missing"),
    promptError: new Error("recovery prompt failed"),
  });

  await assert.rejects(() => scheduler.launch(launchInput), VisibleWorkerRecoveryError);

  assert.equal(registry.workers["COA-365"].lifecycle, "review-required");
  assert.match(registry.workers["COA-365"].recoveryNotes.at(-1), /second recovery failure/i);
});

test("global scheduling caps workers at two, prioritizes manual parents, and rejects overlapping scopes", () => {
  const selection = selectGlobalWorkerCandidates({
    queues: [
      {
        source: "watch",
        repositoryIdentity: "repo",
        parent: { identifier: "COA-360" },
        children: [
          { identifier: "COA-362", state: { name: "Ready to Build" }, description: "## Crosby execution\n\n- Parallel: allowed\n- File scope:\n  - `src/a.ts`\n- Verification: `node --test`" },
          { identifier: "COA-363", state: { name: "Ready to Build" }, description: "## Crosby execution\n\n- Parallel: allowed\n- File scope:\n  - `src/a.ts`\n- Verification: `node --test`" },
        ],
      },
      {
        source: "manual",
        repositoryIdentity: "other-repo",
        parent: { identifier: "COA-361" },
        children: [
          { identifier: "COA-364", state: { name: "Ready to Build" }, description: "## Crosby execution\n\n- Parallel: allowed\n- File scope:\n  - `src/b.ts`\n- Verification: `node --test`" },
          { identifier: "COA-365", state: { name: "Ready to Build" }, description: "No declared contract." },
        ],
      },
    ],
  });

  assert.deepEqual(selection.map((entry) => entry.child.identifier), ["COA-364", "COA-362"]);
});

test("integration validates scope and verification before serially merging", async () => {
  const calls = [];
  const result = await integrateWorkerReport({
    child: { identifier: "COA-365", description: "## Crosby execution\n\n- Parallel: sequential\n- File scope:\n  - `in-scope.txt`\n- Verification: `node --test`" },
    worker: { task: { path: "/task", branch: "task-branch", baseSha: "base" } },
    parent: { integrationWorktree: "/parent" },
    report: { outcome: "complete", taskOutcome: "done", summary: "Done", changes: { paths: ["in-scope.txt"], commit: "abc" }, verification: [{ command: "node --test", result: "passed" }], risks: [] },
    operations: {
      collectChangedPaths: async () => ["in-scope.txt"],
      validateChangedPaths: (paths, scopes) => { calls.push(["scope", paths, scopes]); return { valid: true }; },
      runTaskVerification: async () => { calls.push(["verify"]); return { skipped: false, results: [] }; },
      safeCommit: async () => ({ committed: false, sha: "abc" }),
      serializedMerge: async () => { calls.push(["merge"]); return { merged: true, sha: "merged" }; },
    },
  });

  assert.equal(result.outcome, "done");
  assert.deepEqual(calls.map(([name]) => name), ["scope", "verify", "merge"]);
});

test("scope violations retain the task worktree for review instead of reporting Done", async () => {
  const result = await integrateWorkerReport({
    child: { identifier: "COA-365", description: "## Crosby execution\n\n- Parallel: sequential\n- File scope:\n  - `in-scope.txt`\n- Verification: `node --test`" },
    worker: { task: { path: "/task", branch: "task-branch", baseSha: "base" } },
    parent: { integrationWorktree: "/parent" },
    report: { outcome: "complete", taskOutcome: "done", summary: "Done", changes: { paths: ["outside.txt"], commit: "abc" }, verification: [{ command: "node --test", result: "passed" }], risks: [] },
    operations: {
      collectChangedPaths: async () => ["outside.txt"],
      validateChangedPaths: () => { throw new Error("outside declared scope"); },
    },
  });

  assert.equal(result.outcome, "review");
  assert.equal(result.retained.taskWorktreePath, "/task");
  assert.match(result.summary, /outside declared scope/);
});

test("final integration checks run in order and fail closed", async () => {
  const calls = [];
  await assert.rejects(
    () => runFinalIntegrationChecks({
      parentWorktreePath: "/parent",
      config: { version: 1, finalIntegrationCommands: ["first", "second"] },
      operations: {
        runTaskVerification: async ({ cwd, verification }) => {
          calls.push([cwd, verification]);
          throw new Error("second check failed");
        },
      },
    }),
    /second check failed/,
  );
  assert.deepEqual(calls, [["/parent", ["first", "second"]]]);
});

test("supervisor controls require confirmation for stop and cleanup while retaining task evidence until cleanup", async () => {
  const existingWorker = {
    lifecycle: "running",
    attemptCount: 1,
    task: { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" },
    parentWorktree: { path: "/managed/COA-360/parent" },
    herdr: { workspace: "workspace-1", tab: "tab-365", pane: "pane-365", agent: "crosby-coa-365" },
  };
  const { registry, calls } = harness({ existingWorker });
  const cleaned = [];
  const supervisor = createCrosbySupervisor({
    registryRoot: "/registry",
    repositoryIdentity: "repo",
    parentKey: "COA-360",
    herdr: {
      inspectAgent: async ({ agent }) => ({ name: agent, state: "working" }),
      promptAgent: async (input) => { calls.push(["promptAgent", input]); return { state: "working" }; },
      closeTaskTab: async (input) => { calls.push(["closeTaskTab", input]); return { tab: input.tab }; },
    },
    createRegistryStore: () => ({ root: "/registry", repositoryIdentity: "repo", parentKey: "COA-360" }),
    readRegistry: async () => structuredClone(registry),
    updateWorkerRecord: async (_store, key, patch) => {
      registry.workers[key] = { ...(registry.workers[key] ?? {}), ...structuredClone(patch) };
      return registry.workers[key];
    },
    cleanupTask: async ({ worker }) => cleaned.push(worker.task.path),
  });

  assert.deepEqual(await supervisor.status({ taskKey: "COA-365" }), {
    taskKey: "COA-365",
    lifecycle: "running",
    attempts: 1,
    recoveryAttempts: 0,
    agent: { name: "crosby-coa-365", state: "working" },
    retained: { tab: "tab-365", worktree: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365" },
  });
  assert.equal((await supervisor.stop({ taskKey: "COA-365" })).requiresConfirmation, true);
  assert.equal(registry.workers["COA-365"].lifecycle, "running");

  await supervisor.pause({ taskKey: "COA-365" });
  await supervisor.resume({ taskKey: "COA-365" });
  await supervisor.stop({ taskKey: "COA-365", confirmed: true });
  assert.equal(registry.workers["COA-365"].lifecycle, "stopped");
  assert.equal(registry.workers["COA-365"].task.path, "/managed/COA-360/tasks/COA-365");
  assert.equal((await supervisor.cleanup({ taskKey: "COA-365" })).requiresConfirmation, true);

  await supervisor.cleanup({ taskKey: "COA-365", confirmed: true });
  assert.deepEqual(cleaned, ["/managed/COA-360/tasks/COA-365"]);
  assert.equal(registry.workers["COA-365"].lifecycle, "cleaned");
  assert.equal(registry.workers["COA-365"].task, null);
  assert.equal(registry.workers["COA-365"].herdr, null);
  assert.equal(calls.filter(([operation]) => operation === "closeTaskTab").length, 1);
});

test("reuses the recorded task worktree once, then retains evidence for review after a second recovery failure", async () => {
  const existingWorker = {
    lifecycle: "running",
    attemptCount: 1,
    recoveryAttempts: 0,
    task: { path: "/managed/COA-360/tasks/COA-365", branch: "feature/coa-360/coa-365", baseSha: "task-sha" },
    herdr: { workspace: "workspace-1", tab: "tab-old", pane: "pane-old", agent: "crosby-coa-365" },
  };
  const first = harness({ existingWorker, inspectError: new Error("agent missing") });

  const recovered = await first.scheduler.launch(launchInput);

  assert.equal(recovered.recovered, true);
  assert.equal(first.registry.workers["COA-365"].recoveryAttempts, 1);
  assert.equal(first.calls.some(([operation]) => operation === "createTaskWorktree"), false);

  const second = harness({ existingWorker: first.registry.workers["COA-365"], inspectError: new Error("agent missing again") });
  await assert.rejects(() => second.scheduler.launch(launchInput), VisibleWorkerRecoveryError);
  assert.equal(second.registry.workers["COA-365"].lifecycle, "review-required");
  assert.match(second.registry.workers["COA-365"].recoveryNotes.at(-1), /second recovery failure/i);
});
