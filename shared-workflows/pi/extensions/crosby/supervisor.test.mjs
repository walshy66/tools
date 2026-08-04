import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistryStore, readRegistry } from "./registry.mjs";
import { createHerdrSupervisor } from "./supervisor.mjs";

async function fixture({ repositoryIdentity = "file:///repo" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-supervisor-"));
  const store = createRegistryStore({
    root,
    repositoryIdentity,
    parentKey: "crosby/001-example",
    buildId: "001-example",
    buildFolder: "specs/001-example",
    parentBranch: "crosby/001-example",
    spaceId: "space-1",
  });
  const calls = [];
  const client = {
    calls,
    snapshot: async () => ({ workspaces: [{ id: "space-1" }] }),
    createTaskTab: async (input) => {
      calls.push(["createTaskTab", input]);
      return { workspace: input.workspace, tab: "tab-1", pane: "pane-1" };
    },
    startPiAgent: async (input) => {
      calls.push(["startPiAgent", input]);
      return { name: input.name, pane: input.pane, state: "working" };
    },
    inspectAgent: async (input) => {
      calls.push(["inspectAgent", input]);
      return { name: input.agent, pane: "pane-1", state: "working" };
    },
    promptAgent: async (input) => {
      calls.push(["promptAgent", input]);
      return { state: "working" };
    },
    stopAgent: async (input) => {
      calls.push(["stopAgent", input]);
      return { state: "done" };
    },
    closeTaskTab: async (input) => {
      calls.push(["closeTaskTab", input]);
      return input;
    },
  };
  return { store, client, calls };
}

const task = { id: "task-001", title: "Build parser" };

test("persists the supervisor identity and launches one visible worker without focus", async () => {
  const { store, client, calls } = await fixture();
  const supervisor = createHerdrSupervisor({ client, store });

  await supervisor.ensureSupervisor({ workspace: "space-1", pane: "parent-pane", agent: "parent-agent" });
  const worker = await supervisor.launchWorker({
    task,
    cwd: "/work/task-001",
    prompt: "Implement task-001",
    modelSelection: { model: "openai-codex/gpt-5.6-luna", thinking: "medium", source: "orchestrator" },
  });
  const registry = await readRegistry(store);

  assert.deepEqual(registry.supervisor, {
    workspace: "space-1", pane: "parent-pane", agent: "parent-agent",
  });
  assert.equal(worker.lifecycle, "working");
  assert.equal(worker.tab, "tab-1");
  assert.equal(worker.pane, "pane-1");
  assert.match(worker.agent, /^task-001-[a-f0-9]{8}$/);
  assert.equal(calls[0][0], "createTaskTab");
  assert.equal(calls[0][1].focus, false);
  assert.equal(calls[0][1].label, "Task task-001");
  assert.equal(calls[1][0], "startPiAgent");
  assert.deepEqual(calls[1][1].agentArgs, [
    "--approve",
    "--model", "openai-codex/gpt-5.6-luna",
    "--thinking", "medium",
  ]);
  assert.deepEqual(calls.slice(2), [
    ["promptAgent", { agent: worker.agent, prompt: "Implement task-001", wait: false }],
  ]);
});

test("rebinds stale supervisor identity to the parent running resume", async () => {
  const { store, client } = await fixture();
  const supervisor = createHerdrSupervisor({ client, store });
  await supervisor.ensureSupervisor({ workspace: "space-1", pane: "old-parent-pane", agent: "old-parent-agent" });

  const rebound = await supervisor.ensureSupervisor({ workspace: "space-1", pane: "new-parent-pane", agent: "new-parent-agent" });

  assert.equal(rebound.rebound, true);
  assert.deepEqual((await readRegistry(store)).supervisor, {
    workspace: "space-1", pane: "new-parent-pane", agent: "new-parent-agent",
  });
});

test("scopes worker agent names to the build registry", async () => {
  const first = await fixture({ repositoryIdentity: "file:///repo-one" });
  const second = await fixture({ repositoryIdentity: "file:///repo-two" });

  const firstWorker = await createHerdrSupervisor({ client: first.client, store: first.store })
    .launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });
  const secondWorker = await createHerdrSupervisor({ client: second.client, store: second.store })
    .launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });

  assert.notEqual(firstWorker.agent, secondWorker.agent);
  assert.match(firstWorker.agent, /^task-001-[a-f0-9]{8}$/);
  assert.ok(firstWorker.agent.length <= 32);
});

test("retains a working worker when optional lifecycle telemetry fails", async () => {
  const { store, client } = await fixture();
  const supervisor = createHerdrSupervisor({
    client,
    store,
    emitLifecycle: () => { throw new RangeError("Maximum call stack size exceeded"); },
  });

  const worker = await supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });

  assert.equal(worker.lifecycle, "working");
  assert.match(worker.lifecycleWarning, /Maximum call stack size exceeded/);
  assert.equal((await readRegistry(store)).queueState, "working");
});

test("adopts an existing worker instead of launching a duplicate", async () => {
  const { store, client, calls } = await fixture();
  const supervisor = createHerdrSupervisor({ client, store });
  await supervisor.ensureSupervisor({ workspace: "space-1", pane: "parent-pane", agent: "parent-agent" });
  const launched = await supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });
  calls.length = 0;

  const adopted = await supervisor.adoptWorker(task.id);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.worker.agent, launched.agent);
  assert.deepEqual(calls, [["inspectAgent", { agent: launched.agent }]]);
});

test("guides, pauses, resumes, and explicitly stops the worker", async () => {
  const { store, client } = await fixture();
  const supervisor = createHerdrSupervisor({ client, store });
  await supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });

  await supervisor.guideWorker(task.id, "Check the parser boundary.");
  assert.equal((await supervisor.pauseWorker(task.id)).lifecycle, "paused");
  assert.equal((await supervisor.resumeWorker(task.id)).lifecycle, "working");
  await assert.rejects(() => supervisor.stopWorker(task.id), /explicit confirmation/);
  assert.equal((await supervisor.stopWorker(task.id, { confirm: true })).lifecycle, "cancelled");
  assert.equal((await readRegistry(store)).queueState, "cancelled");
});

test("retains a newly created tab when agent launch fails so the operator can inspect evidence", async () => {
  const { store, client, calls } = await fixture();
  client.startPiAgent = async (input) => { calls.push(["startPiAgent", input]); throw new Error("agent unavailable"); };
  const supervisor = createHerdrSupervisor({ client, store });

  await assert.rejects(
    supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" }),
    /agent unavailable/,
  );
  const registry = await readRegistry(store);
  assert.deepEqual(calls.map(([name]) => name), ["createTaskTab", "startPiAgent"]);
  assert.equal(registry.workers[task.id].lifecycle, "launch-failed");
  assert.equal(registry.workers[task.id].tab, "tab-1");
  assert.equal(registry.workers[task.id].pane, "pane-1");
});
