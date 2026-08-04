import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatBuildProgress, parseBuildCommandArgs, runBuild, summarizeBuildProgress } from "./build-runner.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";

const tasks = `# Build: 001-example

**Parent branch**: \`crosby/001-example\`

## task-001 — First
**Dependencies**: none
**Outcome**: First
### Acceptance criteria
- First works.
### Crosby execution
- Parallel: sequential
- File scope:
  - \`src/first.mjs\`
- Verification:
  - \`node --test first\`
### Instructions
Implement first.
### Guardrails
Stay scoped.

## task-002 — Second
**Dependencies**: task-001
**Outcome**: Second
### Acceptance criteria
- Second works.
### Crosby execution
- Parallel: sequential
- File scope:
  - \`src/second.mjs\`
- Verification:
  - \`node --test second\`
### Instructions
Implement second.
### Guardrails
Stay scoped.
`;

test("parses run, resume, and status build commands", () => {
  assert.deepEqual(parseBuildCommandArgs("run specs/001-example"), { mode: "run", buildFolder: "specs/001-example" });
  assert.deepEqual(parseBuildCommandArgs("resume specs/001-example"), { mode: "resume", buildFolder: "specs/001-example" });
  assert.throws(() => parseBuildCommandArgs("run"), /Usage/);
});

test("summarizes every authored task without mutating tasks.md", () => {
  const build = {
    buildId: "001-example",
    tasks: [
      { id: "task-001", title: "First", executionMode: "AFK" },
      { id: "task-002", title: "Second", executionMode: "AFK" },
      { id: "task-003", title: "Approve", executionMode: "HITL" },
    ],
  };
  const progress = summarizeBuildProgress({
    build,
    registry: {
      queueState: "ready",
      currentTask: "task-002",
      workers: {
        "task-001": { lifecycle: "integrated" },
        "task-002": { lifecycle: "reported" },
      },
    },
  });

  assert.deepEqual(progress.tasks.map(({ id, state }) => ({ id, state })), [
    { id: "task-001", state: "completed" },
    { id: "task-002", state: "awaiting integration" },
    { id: "task-003", state: "human gate" },
  ]);
  assert.match(formatBuildProgress(progress), /1\/3 completed; 2 remaining; current: task-002/);
  assert.match(formatBuildProgress(progress), /✓ task-001 completed/);
  assert.match(formatBuildProgress(progress), /! task-002 awaiting integration/);
});

test("runs tasks strictly in authored order and requires explicit complete reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-build-"));
  const buildFolder = path.join(root, "specs", "001-example");
  await mkdir(buildFolder, { recursive: true });
  await writeFile(path.join(buildFolder, "tasks.md"), tasks);
  const calls = [];
  const progressUpdates = [];
  const storeRoot = path.join(root, "registry");
  const expectedStore = createRegistryStore({
    root: storeRoot,
    repositoryIdentity: root,
    parentKey: "crosby/001-example",
    buildId: "001-example",
    buildFolder,
    parentBranch: "crosby/001-example",
    spaceId: "space-1",
  });
  const supervisor = {
    ensureSupervisor: async () => {},
    launchWorker: async ({ task, prompt, modelSelection }) => {
      assert.equal((await readRegistry(expectedStore)).currentTask, null, "progress tracking must not claim the queue gate");
      assert.match(prompt, /Read the complete task contract from .*tasks\.md/);
      assert.match(prompt, /complete allowed file scope is: src\/(first|second)\.mjs/);
      assert.match(prompt, /submit a blocked report naming the missing path/);
      assert.doesNotMatch(prompt, /First works\.|Second works\./);
      const expectedModel = task.id === "task-001" ? "openai-codex/gpt-5.6-luna" : "openai-codex/gpt-5.6-terra";
      assert.deepEqual(modelSelection, { model: expectedModel, thinking: "medium", source: "orchestrator" });
      calls.push(`launch:${task.id}`);
      return { agent: task.id };
    },
  };
  const result = await runBuild({
    buildFolder,
    sourcePath: root,
    workspace: "space-1",
    pane: "pane-1",
    agent: "supervisor",
    registryRoot: storeRoot,
    adapters: {
      createManagedRepository: async () => ({ barePath: "/bare", worktreeRoot: "/work", sourceHead: "source-head" }),
      createParentWorktree: async ({ baseRef }) => {
        assert.equal(baseRef, "source-head");
        return { path: "/work/parent", branch: "crosby/001-example", baseSha: "source-head" };
      },
      createTaskWorktree: async ({ childKey, taskBranch }) => {
        assert.equal(taskBranch, `crosby/001-example-${childKey}`);
        return { path: `/work/${childKey}`, branch: taskBranch, baseSha: "base" };
      },
      createHerdrSupervisor: () => supervisor,
      selectTaskModel: async ({ task }) => ({
        model: task.id === "task-001" ? "openai-codex/gpt-5.6-luna" : "openai-codex/gpt-5.6-terra",
        thinking: "medium",
        source: "orchestrator",
      }),
      waitForReport: async ({ task }) => { calls.push(`report:${task.id}`); return { outcome: "complete" }; },
      integrateTask: async ({ task }) => { calls.push(`integrate:${task.id}`); },
      onProgress: async (progress) => { progressUpdates.push(progress); },
    },
  });
  assert.deepEqual(calls, ["launch:task-001", "report:task-001", "integrate:task-001", "launch:task-002", "report:task-002", "integrate:task-002"]);
  assert.equal(result.completed.length, 2);
  const finalRegistry = await readRegistry(result.registry);
  assert.equal(Object.keys(finalRegistry.tasks).length, 2);
  assert.equal(finalRegistry.currentTask, null);
  assert.deepEqual(progressUpdates.map((progress) => [progress.completed, progress.remaining]), [[1, 1], [2, 0]]);
  const firstWorker = finalRegistry.workers["task-001"];
  assert.deepEqual(firstWorker.taskWorktree, {
    path: "/work/task-001",
    branch: "crosby/001-example-task-001",
    baseSha: "base",
  });
  assert.deepEqual(firstWorker.modelSelection, {
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    source: "orchestrator",
  });
});

test("fails closed when an unstarted managed parent predates the committed source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-stale-parent-"));
  const buildFolder = path.join(root, "specs", "001-example");
  await mkdir(buildFolder, { recursive: true });
  await writeFile(path.join(buildFolder, "tasks.md"), tasks.split("\n## task-002")[0]);

  await assert.rejects(
    runBuild({
      buildFolder,
      sourcePath: root,
      workspace: "space-1",
      pane: "pane-1",
      agent: "supervisor",
      registryRoot: path.join(root, "registry"),
      adapters: {
        createManagedRepository: async () => ({ barePath: "/bare", worktreeRoot: "/work", sourceHead: "current-source" }),
        createParentWorktree: async () => ({ path: "/work/parent", branch: "crosby/001-example", baseSha: "stale-source" }),
        createHerdrSupervisor: () => ({ ensureSupervisor: async () => {} }),
      },
    }),
    /managed parent predates committed source/,
  );
});

test("stops at a HITL task before selecting a model or launching a worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-hitl-"));
  const buildFolder = path.join(root, "specs", "001-example");
  await mkdir(buildFolder, { recursive: true });
  const hitlTask = tasks
    .split("\n## task-002")[0]
    .replace("**Outcome**: First", "**Outcome**: First\n**Execution mode**: HITL");
  await writeFile(path.join(buildFolder, "tasks.md"), hitlTask);

  await assert.rejects(
    runBuild({
      buildFolder,
      sourcePath: root,
      workspace: "space-1",
      pane: "pane-1",
      agent: "supervisor",
      registryRoot: path.join(root, "registry"),
      adapters: {
        createManagedRepository: async () => ({ barePath: "/bare", worktreeRoot: "/work" }),
        createParentWorktree: async () => ({ path: "/work/parent", branch: "crosby/001-example" }),
        createHerdrSupervisor: () => ({
          ensureSupervisor: async () => {},
          launchWorker: async () => { throw new Error("must not launch HITL task"); },
        }),
        selectTaskModel: async () => { throw new Error("must not select a model for HITL task"); },
      },
    }),
    /human gate task-001/,
  );
});

test("resume integrates a reported worker from its persisted worktree without relaunching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-resume-"));
  const buildFolder = path.join(root, "specs", "001-example");
  await mkdir(buildFolder, { recursive: true });
  await writeFile(path.join(buildFolder, "tasks.md"), tasks.split("\n## task-002")[0]);
  const storeRoot = path.join(root, "registry");
  const store = createRegistryStore({
    root: storeRoot,
    repositoryIdentity: root,
    parentKey: "crosby/001-example",
    buildId: "001-example",
    buildFolder,
    parentBranch: "crosby/001-example",
    spaceId: "space-1",
  });
  const taskWorktree = { path: "/work/task-001", branch: "crosby/001-example-task-001", baseSha: "base" };
  const report = { outcome: "complete", summary: "done" };
  await updateRegistry(store, (registry) => ({
    ...registry,
    workers: { "task-001": { taskId: "task-001", lifecycle: "reported", report, taskWorktree } },
  }));
  const calls = [];

  const result = await runBuild({
    buildFolder,
    sourcePath: root,
    workspace: "space-1",
    pane: "pane-1",
    agent: "supervisor",
    registryRoot: storeRoot,
    adapters: {
      createManagedRepository: async () => ({ barePath: "/bare", worktreeRoot: "/work" }),
      createParentWorktree: async () => ({ path: "/work/parent", branch: "crosby/001-example" }),
      createTaskWorktree: async () => { throw new Error("must reuse persisted worktree"); },
      createHerdrSupervisor: () => ({
        ensureSupervisor: async () => {},
        launchWorker: async () => { throw new Error("must not relaunch reported worker"); },
      }),
      waitForReport: async () => { throw new Error("must reuse persisted report"); },
      integrateTask: async (input) => { calls.push(input); },
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].taskWorktree, taskWorktree);
  assert.deepEqual(calls[0].report, report);
  assert.equal(result.completed.length, 1);
});
