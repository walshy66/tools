import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatBuildProgress, parseBuildCommandArgs, runBuild, summarizeBuildProgress } from "./build-runner.mjs";
import { contractHash } from "./quality-gates.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";

const tasks = `# Build: 001-example

**Parent branch**: \`crosby/001-example\`

## Parent Review Context
Review the combined modules.
## Parent Browser Acceptance
Browser testing: not applicable
Reason: Backend modules only.

## task-001 — First
**Dependencies**: none
**Outcome**: First
### Acceptance criteria
- First works.
### Review Context
Review the first module and its tests.
### Browser Acceptance
Browser testing: not applicable
Reason: Backend module only.
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
### Review Context
Review the second module and its tests.
### Browser Acceptance
Browser testing: not applicable
Reason: Backend module only.
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
  assert.equal(formatBuildProgress(progress).split("\n").length, 1);
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
      verifyTask: async ({ task }) => ({ outcome: "passed", contractHash: contractHash(task) }),
      verifyParent: async () => ({ outcome: "passed" }),
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
    path: "/work/task-001-source-head",
    branch: "crosby/001-example-task-001-source-head",
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

  const reviews = [];
  const result = await runBuild({
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
      onTaskReview: async (event) => reviews.push(event),
    },
  });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].task.id, "task-001");
  assert.equal(result.completed.length, 0);
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
      verifyTask: async ({ task }) => ({ outcome: "passed", contractHash: contractHash(task) }),
      verifyParent: async () => ({ outcome: "passed" }),
      integrateTask: async (input) => { calls.push(input); },
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].taskWorktree, taskWorktree);
  assert.deepEqual(calls[0].report, report);
  assert.equal(result.completed.length, 1);
});

async function fixture(markdown = tasks.split("\n## task-002")[0]) {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-gates-"));
  await writeFile(path.join(root, "tasks.md"), markdown);
  const calls = [];
  const options = { buildFolder: root, sourcePath: root, registryRoot: path.join(root, "registry"), adapters: {
    createManagedRepository: async () => ({}),
    createParentWorktree: async () => ({ path: "/parent", baseSha: "base" }),
    readWorktreeHead: async () => "base",
    createTaskWorktree: async ({ childKey }) => ({ path: `/${childKey}`, branch: childKey, baseSha: "base" }),
    createHerdrSupervisor: () => ({ ensureSupervisor: async () => {}, launchWorker: async ({ task }) => { calls.push(`launch:${task.id}`); return { agent: task.id }; } }),
    selectTaskModel: async () => ({ model: "test/model", thinking: "medium", source: "orchestrator" }),
    waitForReport: async () => ({ outcome: "complete" }),
    verifyTask: async ({ task }) => ({ outcome: "passed", contractHash: contractHash(task) }),
    verifyParent: async () => ({ outcome: "passed" }),
    integrateTask: async ({ task }) => calls.push(`integrate:${task.id}`),
    removeTaskWorktree: async () => calls.push("remove"),
  } };
  return { options, calls };
}

test('resume retries failed GitHub finalization without rebuilding or reintegrating the child', async () => {
  const {options,calls}=await fixture();let attempts=0;
  options.adapters.onTaskIntegrated=async()=>{if(attempts++===0)throw new Error('GitHub unavailable');};
  await assert.rejects(runBuild(options),/GitHub unavailable/);
  const result=await runBuild({...options,resume:true});
  assert.equal(result.readyForReview,true);assert.equal(attempts,2);
  assert.equal(calls.filter(x=>x==='launch:task-001').length,1);
  assert.equal(calls.filter(x=>x==='integrate:task-001').length,1);
});

test("missing child verification fails closed and retains worktree", async () => {
  const { options, calls } = await fixture();
  delete options.adapters.verifyTask;
  const result = await runBuild(options);
  assert.equal(result.readyForReview, false);
  assert.equal(result.blockers.length, 1);
  assert.deepEqual(calls, ["launch:task-001"]);
});

test("parent verification is mandatory after child gates and integration", async () => {
  const { options, calls } = await fixture();
  options.adapters.verifyTask = async ({ task }) => { calls.push("verify"); return { outcome: "passed", contractHash: contractHash(task) }; };
  options.adapters.verifyParent = async () => { calls.push("parent"); return { outcome: "blocked", summary: "Ambiguous failure", requiredHumanAction: "Inspect parent" }; };
  const result = await runBuild(options);
  assert.deepEqual(calls, ["launch:task-001", "verify", "integrate:task-001", "parent"]);
  assert.equal(result.readyForReview, false);
  assert.match(result.blockers[0].summary, /Ambiguous/);
  options.adapters.verifyParent = async () => ({ outcome: "passed" });
  assert.equal((await runBuild(options)).readyForReview, true);
  delete options.adapters.verifyParent;
  assert.equal((await runBuild(options)).readyForReview, false);
});

test("manual prerequisite blocks dependents but independent tasks proceed", async () => {
  const independent = tasks.slice(tasks.indexOf("## task-002")).replaceAll("task-002", "task-003").replace("**Dependencies**: task-001", "**Dependencies**: none");
  const markdown = tasks.replace("**Outcome**: First", "**Execution mode**: HITL" + String.fromCharCode(10) + "**Source state**: Review" + String.fromCharCode(10) + "**Outcome**: First") + independent;
  const { options, calls } = await fixture(markdown);
  const result = await runBuild(options);
  assert.deepEqual(calls, ["launch:task-003", "integrate:task-003"]);
  assert.equal(result.blockers.length, 2);
});

test("three shared repair attempts retain evidence and cannot reset on resume", async () => {
  const { options, calls } = await fixture();
  let checks = 0;
  options.adapters.verifyTask = async () => ({ outcome: "changes-required", summary: `finding-${++checks}`, reports: [{ role: checks % 2 ? "reviewer" : "tester" }] });
  options.adapters.repairTask = async ({ findings, taskWorktree, worker, store, prompt }) => {
    assert.match(prompt, /finding-/);
    assert.equal(taskWorktree.path, "/task-001-base");
    assert.equal((await readRegistry(store)).workers["task-001"].report, null);
    calls.push(`repair:${findings.summary}`);
    return worker;
  };
  const result = await runBuild(options);
  assert.equal(checks, 4);
  let worker = (await readRegistry(result.registry)).workers["task-001"];
  assert.equal(worker.repairAttempts, 3);
  assert.equal(worker.evidence.filter((entry) => entry.outcome === "changes-required").length, 4);
  assert.equal(calls.filter((call) => call.startsWith("integrate")).length, 0);
  await runBuild({ ...options, resume: true });
  worker = (await readRegistry(result.registry)).workers["task-001"];
  assert.equal(worker.repairAttempts, 3);
  assert.equal(calls.filter((call) => call.startsWith("repair")).length, 3);
});

test("blocked builds wait for explicit resume and then reverify retained completion", async () => {
  const { options, calls } = await fixture();
  options.adapters.verifyTask = async () => ({ outcome: "blocked", summary: "Needs credentials", requiredHumanAction: "Supply credentials" });
  const first = await runBuild(options);
  options.adapters.verifyTask = async () => ({ outcome: "passed" });
  assert.equal((await runBuild(options)).readyForReview, false);
  assert.equal((await runBuild({ ...options, resume: true })).readyForReview, true);
  assert.deepEqual(calls, ["launch:task-001", "integrate:task-001"]);
  assert.ok((await readRegistry(first.registry)).workers["task-001"].evidence.length);
});

test("failed builder preserves evidence and continues independent tasks", async () => {
  const { options, calls } = await fixture(tasks.replace("**Dependencies**: task-001", "**Dependencies**: none"));
  options.adapters.waitForReport = async ({ task }) => ({ outcome: task.id === "task-001" ? "failed" : "complete", summary: "Builder result" });
  const result = await runBuild(options);
  assert.equal(result.blockers.length, 1);
  assert.deepEqual(calls, ["launch:task-001", "launch:task-002", "integrate:task-002"]);
});

test("integration receives persisted exact gates on initial run and manual resume", async () => {
  const { options } = await fixture();
  const gates = { outcome: "passed", summary: "Reviewed", reports: [{ revision: "abc" }], revision: "abc", contractHash: "contract" };
  options.adapters.verifyTask = async () => gates;
  options.adapters.integrateTask = async ({ gates: actual }) => assert.deepEqual(actual, gates);
  const result = await runBuild(options);
  assert.deepEqual((await readRegistry(result.registry)).workers["task-001"].gates, gates);
  await updateRegistry(result.registry, (registry) => ({ ...registry, workers: { ...registry.workers, "task-001": { ...registry.workers["task-001"], lifecycle: "review-required" } } }));
  let checks = 0;
  options.adapters.verifyTask = async () => { checks++; return gates; };
  await runBuild({ ...options, resume: true });
  assert.equal(checks, 1);
});

test("waiting progress includes concise reason and required action", () => {
  const text = formatBuildProgress({ build: { buildId: "b", tasks: [{ id: "t", title: "title" }] }, registry: { workers: { t: { lifecycle: "review", report: { summary: "Credentials absent", requiredHumanAction: "Sign in" } } } } });
  assert.match(text, /Credentials absent/);
  assert.match(text, /Sign in/);
  assert.equal(text.split(String.fromCharCode(10)).length, 1);
});

test("forward dependencies run in dependency order", async () => {
  const split = tasks.indexOf("## task-002");
  const start = tasks.indexOf("## task-001");
  const { options, calls } = await fixture(tasks.slice(0, start) + tasks.slice(split) + tasks.slice(start, split));
  const result = await runBuild(options);
  assert.deepEqual(calls, ["launch:task-001", "integrate:task-001", "launch:task-002", "integrate:task-002"]);
  assert.equal(result.readyForReview, true);
});

test("contract errors are actionable and never launch", async () => {
  const { options, calls } = await fixture(tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("**Outcome**: First", "**Contract error**: Missing browser metadata" + String.fromCharCode(10) + "**Outcome**: First"));
  const result = await runBuild(options);
  assert.deepEqual(calls, []);
  assert.match(result.blockers[0].summary, /Missing browser metadata/);
});

test("source Review and AFK Done never bypass child verification", async () => {
  for (const state of ["Review", "Done"]) {
    const { options, calls } = await fixture(tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("**Outcome**: First", `**Source state**: ${state}` + String.fromCharCode(10) + "**Outcome**: First"));
    options.adapters.verifyTask = async () => ({ outcome: "blocked", summary: "Not reviewed" });
    const result = await runBuild(options);
    assert.equal(result.readyForReview, false);
    assert.deepEqual(calls, state === "Done" ? [] : ["launch:task-001"]);
    if (state === "Done") assert.match(result.blockers[0].summary, /closed AFK/i);
  }
});

test("HITL explicit approval or source Done satisfies dependencies, never Review", async () => {
  const markdown = tasks.replace("**Outcome**: First", "**Execution mode**: HITL" + String.fromCharCode(10) + "**Outcome**: First");
  const { options, calls } = await fixture(markdown);
  const first = await runBuild(options);
  await updateRegistry(first.registry, (registry) => ({ ...registry, workers: { ...registry.workers, "task-001": { ...registry.workers["task-001"], humanApproval: { approved: true, approvedBy: "operator", approvedAt: new Date().toISOString() } } } }));
  assert.equal((await runBuild({ ...options, resume: true })).readyForReview, true);
  assert.deepEqual(calls, ["launch:task-002", "integrate:task-002"]);
  const done = await fixture(markdown.replace("**Execution mode**: HITL", "**Execution mode**: HITL" + String.fromCharCode(10) + "**Source state**: Done"));
  assert.equal((await runBuild(done.options)).readyForReview, true);
});

test("integration errors return actionable blockers while independent work continues", async () => {
  const { options } = await fixture(tasks.replace("**Dependencies**: task-001", "**Dependencies**: none"));
  options.adapters.integrateTask = async ({ task }) => { if (task.id === "task-001") throw new Error("Conflict"); };
  const result = await runBuild(options);
  assert.equal(result.completed.length, 1);
  assert.match(result.blockers[0].summary, /Conflict/);
});

test("launch interruption is actionable and does not stop independent tasks", async () => {
  const { options, calls } = await fixture(tasks.replace("**Dependencies**: task-001", "**Dependencies**: none"));
  options.adapters.createHerdrSupervisor = () => ({ ensureSupervisor: async () => {}, launchWorker: async ({ task }) => { if (task.id === "task-001") throw new Error("Disconnected"); return { agent: task.id }; } });
  const result = await runBuild(options);
  assert.match(result.blockers[0].summary, /Disconnected/);
  assert.deepEqual(calls, ["integrate:task-002"]);
});

test("repair guides existing builder and waits for fresh completion before passing gates", async () => {
  const { options, calls } = await fixture();
  let checks = 0, reports = 0;
  options.adapters.createHerdrSupervisor = () => ({ ensureSupervisor: async () => {},
    launchWorker: async () => { calls.push("launch"); return { agent: "builder" }; },
    guideWorker: async (id, prompt) => { assert.match(prompt, /Fix behavior/); calls.push("guide"); return { agent: "builder" }; },
  });
  options.adapters.waitForReport = async () => ({ outcome: "complete", summary: `report-${++reports}` });
  options.adapters.verifyTask = async ({ report }) => {
    assert.equal(report.summary, `report-${++checks}`);
    return checks === 1 ? { outcome: "changes-required", summary: "Fix behavior", reports: [] } : { outcome: "passed" };
  };
  const result = await runBuild(options);
  assert.equal(result.readyForReview, true);
  assert.deepEqual(calls, ["launch", "guide", "integrate:task-001"]);
});

test("interrupted repair resume retains findings, worktree and consumed attempt", async () => {
  const { options } = await fixture();
  options.adapters.verifyTask = async () => ({ outcome: "changes-required", summary: "Retained finding", reports: [] });
  options.adapters.repairTask = async () => { throw new Error("Repair disconnected"); };
  const first = await runBuild(options);
  let prompt;
  delete options.adapters.repairTask;
  options.adapters.createHerdrSupervisor = () => ({ ensureSupervisor: async () => {}, launchWorker: async (input) => { prompt = input.prompt; return { agent: "builder" }; } });
  options.adapters.createTaskWorktree = async () => { throw new Error("Must retain worktree"); };
  options.adapters.verifyTask = async () => ({ outcome: "passed" });
  const resumed = await runBuild({ ...options, resume: true });
  assert.match(prompt, /Retained finding/);
  assert.equal(resumed.readyForReview, true);
  assert.equal((await readRegistry(first.registry)).workers["task-001"].repairAttempts, 1);
});

test("legacy external source Done requires an explicit completion record", async () => {
  const markdown = tasks.replace("**Outcome**: First", "**Source state**: Done" + String.fromCharCode(10) + "**Outcome**: First");
  const { options, calls } = await fixture(markdown);
  options.adapters.verifyTask = async () => ({ outcome: "blocked", summary: "No external record" });
  const first = await runBuild(options);
  await updateRegistry(first.registry, (registry) => ({ ...registry, workers: { ...registry.workers,
    "task-001": { externalCompletion: { confirmed: true, recordedBy: "operator", recordedAt: new Date().toISOString(), reason: "Legacy issue already integrated outside Crosby" } } } }));
  calls.length = 0;
  options.adapters.verifyTask = async () => ({ outcome: "passed" });
  const result = await runBuild({ ...options, resume: true });
  assert.equal(result.readyForReview, true);
  assert.deepEqual(calls, ["launch:task-002", "integrate:task-002"]);
  assert.equal((await readRegistry(result.registry)).workers["task-001"].completionBasis, "source-done-external");
});

test("review notifications cannot stop independent tasks and missing actions get a default", async () => {
  const { options } = await fixture(tasks.replace("**Dependencies**: task-001", "**Dependencies**: none"));
  options.adapters.verifyTask = async ({ task }) => ({ outcome: task.id === "task-001" ? "blocked" : "passed", summary: "Gate result" });
  options.adapters.onTaskReview = async () => { throw new Error("Notification unavailable"); };
  const result = await runBuild(options);
  assert.equal(result.completed.length, 1);
  assert.match(result.blockers[0].requiredHumanAction, /resume/);
  assert.match((await readRegistry(result.registry)).workers["task-001"].reviewUpdateError, /Notification unavailable/);
});

test("integrated contract changes block until explicitly reopened and reverified", async () => {
  const { options, calls } = await fixture();
  const first = await runBuild(options);
  await writeFile(path.join(options.buildFolder, "tasks.md"), tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("First works.", "First works differently."));
  calls.length = 0;
  const changed = await runBuild({ ...options, resume: true });
  assert.equal(changed.readyForReview, false);
  assert.match(changed.blockers[0].summary, /contract.*changed/i);
  assert.deepEqual(calls, []);
  assert.equal((await readRegistry(first.registry)).workers["task-001"].lifecycle, "review-required");
});

test("mixed HITL with retained code must pass verification despite human approval and source Done", async () => {
  const { options, calls } = await fixture();
  options.adapters.verifyTask = async () => ({ outcome: "blocked", summary: "Code not approved" });
  const first = await runBuild(options);
  await writeFile(path.join(options.buildFolder, "tasks.md"), tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("**Outcome**: First", ["**Execution mode**: HITL", "**Source state**: Done", "**Outcome**: First"].join(String.fromCharCode(10))));
  await updateRegistry(first.registry, (registry) => ({ ...registry, workers: { ...registry.workers, "task-001": { ...registry.workers["task-001"], humanApproval: { approved: true, approvedBy: "human", approvedAt: "today" } } } }));
  let verified = 0;
  options.adapters.verifyTask = async () => { verified++; return { outcome: "blocked", summary: "Code not approved" }; };
  const result = await runBuild({ ...options, resume: true });
  assert.equal(verified, 1);
  assert.equal(result.readyForReview, false);
  assert.deepEqual(calls, ["launch:task-001"]);
});

test("resume guard blocks leftover gate agents before builder or verification", async () => {
  const { options, calls } = await fixture();
  const first = await runBuild(options);
  await updateRegistry(first.registry, (registry) => ({ ...registry, workers: { ...registry.workers, "task-001": { ...registry.workers["task-001"], lifecycle: "review-required" } } }));
  calls.length = 0;
  options.adapters.beforeTaskResume = async ({ task, worker, store }) => {
    assert.equal(task.id, "task-001");
    assert.ok(worker.taskWorktree);
    assert.ok(store);
    return { outcome: "blocked", summary: "Reviewer still active", requiredHumanAction: "Stop reviewer" };
  };
  options.adapters.verifyTask = async () => { calls.push("verify"); return { outcome: "passed" }; };
  const result = await runBuild({ ...options, resume: true });
  assert.deepEqual(calls, []);
  assert.match(result.blockers[0].summary, /Reviewer still active/);
});

test("parent contract errors block final readiness but not child work", async () => {
  const { options, calls } = await fixture(tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("## Parent Review Context", "## Unrelated context"));
  options.adapters.verifyParent = async () => { throw new Error("Must not verify invalid parent contract"); };
  const result = await runBuild(options);
  assert.deepEqual(calls, ["launch:task-001", "integrate:task-001"]);
  assert.equal(result.readyForReview, false);
  assert.match(result.blockers[0].summary, /Missing Review Context/);
});

test("repair transition emits running progress with findings and action", async () => {
  const { options } = await fixture();
  const updates = [];
  let checks = 0;
  options.adapters.verifyTask = async () => ++checks === 1 ? { outcome: "changes-required", summary: "Fix regression", requiredHumanAction: "Inspect failing test" } : { outcome: "passed" };
  options.adapters.onProgress = async (progress) => updates.push(progress);
  await runBuild(options);
  assert.equal(updates[0].tasks[0].state, "running");
  assert.match(formatBuildProgress(updates[0]), /Fix regression/);
});

test("guard blocking first verification retains builder completion for safe retry", async () => {
  const { options, calls } = await fixture();
  options.adapters.beforeTaskResume = async () => ({ outcome: "blocked", summary: "Gate agent active" });
  const first = await runBuild(options);
  assert.equal((await readRegistry(first.registry)).workers["task-001"].completionReport.outcome, "complete");
  options.adapters.beforeTaskResume = async () => {};
  assert.equal((await runBuild({ ...options, resume: true })).readyForReview, true);
  assert.deepEqual(calls, ["launch:task-001", "integrate:task-001"]);
});

test("attributable parent repair prepares retained child and reruns child and parent gates", async () => {
  const { options, calls } = await fixture(tasks);
  let parentChecks = 0;
  options.adapters.verifyParent = async () => ++parentChecks === 1
    ? { outcome: "changes-required", repairable: true, repairTaskId: "task-001", summary: "Parent regression", reports: [{ stage: "parent" }] }
    : { outcome: "passed" };
  options.adapters.prepareParentRepair = async ({ task, worker, parentWorktree, store }) => {
    assert.equal(task.id, "task-001");
    assert.equal(parentWorktree.path, "/parent");
    assert.equal(worker.repairAttempts, 1);
    assert.equal(worker.gates, null);
    assert.equal(worker.completionReport, null);
    calls.push("prepare");
    return { ...worker.taskWorktree, baseSha: "synced-parent" };
  };
  options.adapters.repairTask = async ({ taskWorktree, findings, worker, store }) => {
    const persisted = (await readRegistry(store)).workers["task-001"];
    assert.equal(persisted.report, null);
    assert.equal(persisted.completionReport, null);
    assert.equal(persisted.gates, null);
    assert.equal(taskWorktree.baseSha, "synced-parent");
    assert.match(findings.summary, /Parent regression/);
    calls.push("repair");
    return worker;
  };
  options.adapters.verifyTask = async ({ task }) => { calls.push(`verify:${task.id}`); return { outcome: "passed", contractHash: contractHash(task) }; };
  const result = await runBuild(options);
  assert.equal(result.readyForReview, true);
  assert.equal(parentChecks, 2);
  assert.deepEqual(calls, ["launch:task-001", "verify:task-001", "integrate:task-001", "launch:task-002", "verify:task-002", "integrate:task-002", "prepare", "repair", "verify:task-001", "integrate:task-001"]);
  assert.equal((await readRegistry(result.registry)).workers["task-001"].repairAttempts, 1);
});

test("parent and child failures share the same durable three-repair budget", async () => {
  const { options } = await fixture();
  let childChecks = 0, preparations = 0;
  options.adapters.verifyTask = async ({ task }) => ++childChecks === 1
    ? { outcome: "changes-required", summary: "Child finding" }
    : { outcome: "passed", contractHash: contractHash(task) };
  options.adapters.verifyParent = async () => ({ outcome: "changes-required", repairable: true, repairTaskId: "task-001", summary: "Parent finding" });
  options.adapters.prepareParentRepair = async () => { preparations++; };
  const result = await runBuild(options);
  assert.equal(result.readyForReview, false);
  assert.equal(preparations, 2);
  assert.equal((await readRegistry(result.registry)).workers["task-001"].repairAttempts, 3);
  assert.equal(result.blockers[0].outcome, "blocked");
  assert.match(result.blockers[0].requiredHumanAction, /limit/);
  await runBuild({ ...options, resume: true });
  assert.equal(preparations, 2);
});

test("failed parent preparation cannot resume builder before safe recovery", async () => {
  const { options, calls } = await fixture();
  options.adapters.verifyParent = async () => ({ outcome: "changes-required", repairable: true, repairTaskId: "task-001", summary: "Parent finding" });
  options.adapters.prepareParentRepair = async () => { throw new Error("Cannot fast-forward"); };
  const result = await runBuild(options);
  assert.equal(result.readyForReview, false);
  assert.equal(result.completed.length, 0);
  calls.length = 0;
  const retry = await runBuild({ ...options, resume: true });
  assert.deepEqual(calls, []);
  assert.equal(retry.readyForReview, false);
  assert.match(retry.blockers[0].requiredHumanAction, /preparation/i);
});

test("ambiguous parent attribution and missing preparation adapter fail closed", async () => {
  for (const mode of ["ambiguous", "unknown-child", "missing-adapter"]) {
    const { options, calls } = await fixture();
    options.adapters.verifyParent = async () => ({ outcome: "changes-required", summary: "Parent failure", repairable: mode !== "ambiguous", repairTaskId: mode === "unknown-child" ? "task-999" : "task-001" });
    if (mode !== "missing-adapter") options.adapters.prepareParentRepair = async () => { calls.push("prepare"); };
    const result = await runBuild(options);
    assert.equal(result.readyForReview, false);
    assert.equal(result.blockers[0].outcome, "blocked");
    assert.deepEqual(calls, ["launch:task-001", "integrate:task-001"]);
    assert.equal((await readRegistry(result.registry)).workers["task-001"].repairAttempts ?? 0, 0);
  }
});

test("blocked preparation result never launches parent repair", async () => {
  const { options, calls } = await fixture();
  options.adapters.verifyParent = async () => ({ outcome: "changes-required", repairable: true, repairTaskId: "task-001", summary: "Parent finding" });
  options.adapters.prepareParentRepair = async () => ({ outcome: "blocked", summary: "Unsafe synchronization" });
  const result = await runBuild(options);
  assert.equal(result.readyForReview, false);
  assert.deepEqual(calls, ["launch:task-001", "integrate:task-001"]);
  assert.match(result.blockers[0].summary, /Unsafe synchronization/);
});

test("closed child parent repair is explicitly marked and guides only with cleared completion", async () => {
  const { options } = await fixture();
  const first = await runBuild(options);
  await writeFile(path.join(options.buildFolder, "tasks.md"), tasks.split(String.fromCharCode(10) + "## task-002")[0].replace("**Outcome**: First", "**Source state**: Done" + String.fromCharCode(10) + "**Outcome**: First"));
  await updateRegistry(first.registry, (registry) => ({ ...registry, workers: { ...registry.workers,
    "task-001": { ...registry.workers["task-001"], agent: "builder" } } }));
  let checks = 0, starts = 0, guides = 0;
  options.adapters.verifyParent = async () => ++checks === 1
    ? { outcome: "changes-required", repairable: true, repairTaskId: "task-001", summary: "Repair closed child" }
    : { outcome: "passed" };
  options.adapters.prepareParentRepair = async ({ worker }) => ({ ...worker.taskWorktree, baseSha: "parent-now" });
  options.adapters.onTaskStarting = async ({ task, registry }) => {
    assert.equal(task.sourceState, "Done");
    assert.equal(registry.workers[task.id].parentRepairPending, true);
    assert.equal(registry.workers[task.id].completionReport, null);
    starts++;
  };
  options.adapters.createHerdrSupervisor = () => ({ ensureSupervisor: async () => {}, guideWorker: async (id, prompt) => {
    const worker = (await readRegistry(first.registry)).workers[id];
    assert.equal(worker.report, null);
    assert.equal(worker.completionReport, null);
    assert.equal(worker.gates, null);
    assert.match(prompt, /Repair closed child/);
    guides++;
    return worker;
  } });
  const result = await runBuild(options);
  assert.equal(result.readyForReview, true);
  assert.equal(starts, 1);
  assert.equal(guides, 1);
  assert.equal((await readRegistry(first.registry)).workers["task-001"].parentRepairPending, false);
});
