import { readRegistry, updateRegistry } from "./registry.mjs";
import { transitionQueue } from "./state-machine.mjs";

export class SupervisorError extends Error {
  constructor(message) {
    super(`${message} Recovery: inspect the retained Herdr tab and durable registry before retrying.`);
    this.name = "SupervisorError";
  }
}

function fail(message) {
  throw new SupervisorError(message);
}

function text(value, name) {
  const result = String(value ?? "").trim();
  if (!result) fail(`${name} must be a non-empty string.`);
  return result;
}

function taskId(task) {
  return text(typeof task === "string" ? task : task?.id, "task ID");
}

export function createHerdrSupervisor({ client, store, emitLifecycle } = {}) {
  if (!client || typeof client.createTaskTab !== "function" || typeof client.startPiAgent !== "function") {
    fail("Herdr supervisor requires a validated Herdr client.");
  }
  if (!store) fail("Herdr supervisor requires a durable registry store.");
  const emit = (payload) => {
    if (typeof emitLifecycle !== "function") return null;
    try {
      emitLifecycle(payload);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  async function ensureSupervisor({ workspace, pane, agent } = {}) {
    const identity = {
      workspace: text(workspace, "supervisor workspace"),
      pane: text(pane, "supervisor pane"),
      agent: text(agent, "supervisor agent"),
    };
    const registry = await readRegistry(store);
    if (registry.supervisor) return { supervisor: registry.supervisor, adopted: true };
    await updateRegistry(store, (current) => ({ ...current, supervisor: identity }));
    return { supervisor: identity, adopted: false };
  }

  async function launchWorker({ task, cwd, prompt, agentArgs, env } = {}) {
    const id = taskId(task);
    const workingDirectory = text(cwd, `${id} worktree`);
    const workerPrompt = text(prompt, `${id} prompt`);
    let registry = await readRegistry(store);
    const existing = registry.workers[id];
    if (existing?.agent && ["launching", "working"].includes(existing.lifecycle)) {
      return (await adoptWorker(id)).worker;
    }
    if (registry.currentTask && registry.currentTask !== id) {
      fail(`Cannot launch ${id}; task ${registry.currentTask} already owns the worker gate.`);
    }

    await updateRegistry(store, (current) => {
      const nextQueue = current.queueState === "ready"
        ? transitionQueue(current, "start", { taskId: id })
        : current;
      return {
        ...current,
        ...nextQueue,
        tasks: { ...current.tasks, [id]: typeof task === "object" ? structuredClone(task) : { id } },
        workers: {
          ...current.workers,
          [id]: { ...(current.workers[id] ?? {}), taskId: id, lifecycle: "launching", cwd: workingDirectory },
        },
      };
    });

    let tab;
    try {
      tab = await client.createTaskTab({ workspace: store.spaceId, label: id, cwd: workingDirectory, focus: false, env });
      await updateRegistry(store, (current) => ({
        ...current,
        workers: { ...current.workers, [id]: { ...current.workers[id], tab: tab.tab, pane: tab.pane } },
      }));
      const baseArgs = agentArgs === undefined || (Array.isArray(agentArgs) && agentArgs.length === 0)
        ? ["--approve"]
        : agentArgs;
      const started = await client.startPiAgent({ pane: tab.pane, name: id, agentArgs: baseArgs });
      await client.promptAgent({ agent: started.name, prompt: workerPrompt, wait: false });
      let worker = await updateRegistry(store, (current) => ({
        ...current,
        workers: { ...current.workers, [id]: { ...current.workers[id], agent: started.name, lifecycle: "working" } },
      }));
      const lifecycleWarning = emit({ taskId: id, lifecycle: "working", agent: started.name, tab: tab.tab });
      if (lifecycleWarning) {
        worker = await updateRegistry(store, (current) => ({
          ...current,
          workers: { ...current.workers, [id]: { ...current.workers[id], lifecycleWarning } },
        }));
      }
      return worker.workers[id];
    } catch (error) {
      await updateRegistry(store, (current) => ({
        ...current,
        queueState: "ready",
        currentTask: null,
        workers: { ...current.workers, [id]: { ...current.workers[id], lifecycle: "launch-failed", launchError: error instanceof Error ? error.message : String(error) } },
      }));
      emit({ taskId: id, lifecycle: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function guideWorker(idValue, guidance) {
    const id = taskId(idValue);
    const message = text(guidance, `${id} guidance`);
    const registry = await readRegistry(store);
    const worker = registry.workers[id];
    if (!worker?.agent) fail(`Cannot guide ${id}; no active worker agent is registered.`);
    if (typeof client.promptAgent !== "function") fail("Herdr client does not support worker guidance.");
    await client.promptAgent({ agent: worker.agent, prompt: message, wait: false });
    return { ...worker, lastGuidance: message };
  }

  async function pauseWorker(idValue) {
    const id = taskId(idValue);
    const registry = await readRegistry(store);
    const worker = registry.workers[id];
    if (!worker?.agent) fail(`Cannot pause ${id}; no active worker agent is registered.`);
    if (typeof client.promptAgent !== "function") fail("Herdr client does not support worker pause.");
    await client.promptAgent({ agent: worker.agent, prompt: "Pause work safely now. Do not make further changes until resumed.", wait: false });
    const saved = (await updateRegistry(store, (current) => {
      const next = current.currentTask === id ? transitionQueue(current, "pause", { taskId: id }) : current;
      return { ...next, workers: { ...next.workers, [id]: { ...next.workers[id], lifecycle: "paused" } } };
    })).workers[id];
    emit({ taskId: id, lifecycle: "paused", agent: worker.agent });
    return saved;
  }

  async function resumeWorker(idValue) {
    const id = taskId(idValue);
    const registry = await readRegistry(store);
    const worker = registry.workers[id];
    if (!worker?.agent) fail(`Cannot resume ${id}; no active worker agent is registered.`);
    if (typeof client.promptAgent !== "function") fail("Herdr client does not support worker resume.");
    await client.promptAgent({ agent: worker.agent, prompt: "Resume work on the assigned task.", wait: false });
    const saved = (await updateRegistry(store, (current) => {
      const next = current.currentTask === id ? transitionQueue(current, "resume", { taskId: id }) : current;
      return { ...next, workers: { ...next.workers, [id]: { ...next.workers[id], lifecycle: "working" } } };
    })).workers[id];
    emit({ taskId: id, lifecycle: "working", agent: worker.agent });
    return saved;
  }

  async function stopWorker(idValue, { confirm = false } = {}) {
    const id = taskId(idValue);
    if (confirm !== true) fail("Stopping a worker requires explicit confirmation.");
    const registry = await readRegistry(store);
    const worker = registry.workers[id];
    if (!worker?.agent) fail(`Cannot stop ${id}; no active worker agent is registered.`);
    if (typeof client.stopAgent === "function") await client.stopAgent({ agent: worker.agent });
    else if (typeof client.sendAgentKeys === "function") await client.sendAgentKeys({ agent: worker.agent, keys: ["ctrl-c"] });
    else fail("Herdr client does not support stopping workers.");
    const saved = (await updateRegistry(store, (current) => {
      const next = current.currentTask === id ? transitionQueue(current, "cancelled", { taskId: id }) : current;
      return { ...next, workers: { ...next.workers, [id]: { ...next.workers[id], lifecycle: "cancelled" } } };
    })).workers[id];
    emit({ taskId: id, lifecycle: "cancelled", agent: worker.agent });
    return saved;
  }

  async function adoptWorker(idValue) {
    const id = taskId(idValue);
    const registry = await readRegistry(store);
    const worker = registry.workers[id];
    if (!worker?.agent) return { adopted: false, recoverable: true, worker: worker ?? null };
    try {
      const inspection = await client.inspectAgent({ agent: worker.agent });
      return { adopted: true, worker: { ...worker, observedState: inspection.state } };
    } catch (error) {
      return { adopted: false, recoverable: true, worker, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ensureSupervisor, launchWorker, adoptWorker, guideWorker, pauseWorker, resumeWorker, stopWorker };
}
