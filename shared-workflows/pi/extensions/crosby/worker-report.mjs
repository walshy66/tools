import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";
import { transitionQueue } from "./state-machine.mjs";
import { validateWorkerReport } from "./worker-protocol.mjs";

function required(env, name) {
  const value = String(env?.[name] ?? "").trim();
  if (!value) throw new Error(`Crosby worker reporting requires ${name}. Recovery: relaunch the task from the Crosby supervisor.`);
  return value;
}

export async function persistWorkerReport({ report, env = process.env, emitHerdrBlocked } = {}) {
  const root = required(env, "CROSBY_REGISTRY_ROOT");
  const repositoryIdentity = required(env, "CROSBY_REPOSITORY_ID");
  const parentKey = required(env, "CROSBY_PARENT_KEY");
  const taskKey = required(env, "CROSBY_TASK_KEY");
  const validated = validateWorkerReport(report);
  const store = createRegistryStore({
    root,
    repositoryIdentity,
    parentKey,
    buildId: env.CROSBY_BUILD_ID || "default",
    buildFolder: env.CROSBY_BUILD_FOLDER || null,
    parentBranch: env.CROSBY_PARENT_BRANCH || null,
    spaceId: env.HERDR_WORKSPACE_ID || "default",
  });
  const existingRegistry = await readRegistry(store);
  if (!existingRegistry.workers?.[taskKey]) throw new Error(`No registered Crosby worker exists for ${taskKey}. Recovery: relaunch the task from the Crosby supervisor.`);
  const wasBlocked = existingRegistry.workers[taskKey].report?.outcome === "blocked";

  const registry = await updateRegistry(store, (current) => {
    const lifecycle = validated.outcome === "complete" ? "reported" : validated.outcome === "blocked" ? "review" : validated.outcome;
    const worker = current.workers[taskKey];
    const next = {
      ...current,
      workers: {
        ...current.workers,
        [taskKey]: { ...worker, lifecycle, report: validated, reportedAt: new Date().toISOString() },
      },
    };
    if (current.currentTask === taskKey) {
      return transitionQueue(next, validated.outcome === "complete" ? "complete" : validated.outcome === "blocked" ? "review" : validated.outcome, { taskId: taskKey });
    }
    return next;
  });
  const saved = registry.workers[taskKey];

  if (typeof emitHerdrBlocked === "function" && validated.outcome !== "blocked" && wasBlocked) {
    emitHerdrBlocked({ active: false });
  }
  return saved;
}
