import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRegistryStore, readRegistry, updateWorkerRecord } from "./registry.mjs";
import { persistWorkerReport } from "./worker-report.mjs";

const completion = {
  outcome: "complete",
  taskOutcome: "implemented",
  summary: "Implemented the task.",
  changes: { paths: ["src/feature.mjs"], commit: "abc123" },
  verification: [{ command: "node --test", result: "passed" }],
  risks: [],
};

function environment(root) {
  return {
    CROSBY_REGISTRY_ROOT: root,
    CROSBY_REPOSITORY_ID: "https://example.test/acme/repo.git",
    CROSBY_PARENT_KEY: "COA-360",
    CROSBY_TASK_KEY: "COA-365",
  };
}

test("persists a validated completion report to its registered worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-worker-report-"));
  const env = environment(root);
  const store = createRegistryStore({ root, repositoryIdentity: env.CROSBY_REPOSITORY_ID, parentKey: env.CROSBY_PARENT_KEY });
  await updateWorkerRecord(store, env.CROSBY_TASK_KEY, { lifecycle: "running" });

  const saved = await persistWorkerReport({ report: completion, env });
  const registry = await readRegistry(store);

  assert.equal(saved.lifecycle, "reported");
  assert.deepEqual(registry.workers[env.CROSBY_TASK_KEY].report, completion);
});

test("persists blocked reports and requests Herdr blocked state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-worker-report-"));
  const env = environment(root);
  const store = createRegistryStore({ root, repositoryIdentity: env.CROSBY_REPOSITORY_ID, parentKey: env.CROSBY_PARENT_KEY });
  await updateWorkerRecord(store, env.CROSBY_TASK_KEY, { lifecycle: "running" });
  const events = [];
  const blocked = {
    outcome: "blocked",
    summary: "Need an API credential.",
    requiredHumanAction: "Provide the credential.",
    recoveryNotes: ["No changes were made."],
    requestHerdrBlocked: true,
  };

  await persistWorkerReport({ report: blocked, env, emitHerdrBlocked: (payload) => events.push(payload) });

  assert.deepEqual(events, [{ active: true, label: "COA-365: Need an API credential." }]);
  assert.equal((await readRegistry(store)).workers[env.CROSBY_TASK_KEY].lifecycle, "blocked");
});

test("refuses a report from an unregistered worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-worker-report-"));
  await assert.rejects(() => persistWorkerReport({ report: completion, env: environment(root) }), /no registered Crosby worker/i);
});
