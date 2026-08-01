import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistryStore, readRegistry } from "./registry.mjs";
import { createHerdrSupervisor } from "./supervisor.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-supervisor-"));
  const store = createRegistryStore({
    root,
    repositoryIdentity: "file:///repo",
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
  const worker = await supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });
  const registry = await readRegistry(store);

  assert.deepEqual(registry.supervisor, {
    workspace: "space-1", pane: "parent-pane", agent: "parent-agent",
  });
  assert.equal(worker.lifecycle, "working");
  assert.equal(worker.tab, "tab-1");
  assert.equal(worker.pane, "pane-1");
  assert.equal(worker.agent, "task-001");
  assert.equal(calls[0][0], "createTaskTab");
  assert.equal(calls[0][1].focus, false);
  assert.equal(calls[1][0], "startPiAgent");
  assert.deepEqual(calls[1][1].agentArgs, ["--approve"]);
  assert.deepEqual(calls[2], ["promptAgent", { agent: "task-001", prompt: "Implement task-001", wait: false }]);
});

test("adopts an existing worker instead of launching a duplicate", async () => {
  const { store, client, calls } = await fixture();
  const supervisor = createHerdrSupervisor({ client, store });
  await supervisor.ensureSupervisor({ workspace: "space-1", pane: "parent-pane", agent: "parent-agent" });
  await supervisor.launchWorker({ task, cwd: "/work/task-001", prompt: "Implement task-001" });
  calls.length = 0;

  const adopted = await supervisor.adoptWorker(task.id);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.worker.agent, "task-001");
  assert.deepEqual(calls, [["inspectAgent", { agent: "task-001" }]]);
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
