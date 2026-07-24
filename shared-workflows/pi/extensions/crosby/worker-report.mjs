import { createRegistryStore, readRegistry, updateWorkerRecord } from "./registry.mjs";
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
  const store = createRegistryStore({ root, repositoryIdentity, parentKey });
  const registry = await readRegistry(store);
  if (!registry.workers?.[taskKey]) throw new Error(`No registered Crosby worker exists for ${taskKey}. Recovery: relaunch the task from the Crosby supervisor.`);

  const saved = await updateWorkerRecord(store, taskKey, {
    lifecycle: validated.outcome === "blocked" ? "blocked" : "reported",
    report: validated,
    reportedAt: new Date().toISOString(),
  });

  if (validated.outcome === "blocked" && typeof emitHerdrBlocked === "function") {
    emitHerdrBlocked({ active: true, label: `${taskKey}: ${validated.summary}` });
  }
  return saved;
}
