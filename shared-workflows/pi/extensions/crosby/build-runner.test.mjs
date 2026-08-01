import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseBuildCommandArgs, runBuild } from "./build-runner.mjs";
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

test("runs tasks strictly in authored order and requires explicit complete reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-build-"));
  const buildFolder = path.join(root, "specs", "001-example");
  await mkdir(buildFolder, { recursive: true });
  await writeFile(path.join(buildFolder, "tasks.md"), tasks);
  const calls = [];
  const storeRoot = path.join(root, "registry");
  const supervisor = {
    ensureSupervisor: async () => {},
    launchWorker: async ({ task, prompt, agentArgs }) => {
      assert.match(prompt, /Read the complete task contract from .*tasks\.md/);
      assert.doesNotMatch(prompt, /First works\.|Second works\./);
      const expectedModel = task.id === "task-001" ? "openai-codex/gpt-5.6-luna" : "openai-codex/gpt-5.6-terra";
      assert.deepEqual(agentArgs, ["--model", expectedModel, "--thinking", "medium", "--approve"]);
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
      createManagedRepository: async () => ({ barePath: "/bare", worktreeRoot: "/work" }),
      createParentWorktree: async () => ({ path: "/work/parent", branch: "crosby/001-example" }),
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
    },
  });
  assert.deepEqual(calls, ["launch:task-001", "report:task-001", "integrate:task-001", "launch:task-002", "report:task-002", "integrate:task-002"]);
  assert.equal(result.completed.length, 2);
  const firstWorker = (await readRegistry(result.registry)).workers["task-001"];
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
