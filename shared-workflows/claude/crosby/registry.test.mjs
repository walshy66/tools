import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REGISTRY_VERSION,
  RegistryError,
  createRegistryStore,
  readRegistry,
  updateRegistry,
  updateWorkerRecord,
  recordWorkerRecovery,
  listAllWorkers,
} from "./registry.mjs";

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-registry-"));
  return createRegistryStore({ root, repositoryIdentity: "file:///repo", parentKey: "COA-360" });
}

test("creates a versioned registry keyed by build and Herdr space", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-registry-"));
  const store = createRegistryStore({
    root,
    repositoryIdentity: "file:///repo",
    parentKey: "crosby/001-example",
    buildId: "001-example",
    buildFolder: "specs/001-example",
    parentBranch: "crosby/001-example",
    spaceId: "space-1",
  });
  const registry = await readRegistry(store);

  assert.equal(registry.version, REGISTRY_VERSION);
  assert.equal(registry.repositoryIdentity, "file:///repo");
  assert.equal(registry.parentKey, "crosby/001-example");
  assert.equal(registry.buildId, "001-example");
  assert.equal(registry.buildFolder, "specs/001-example");
  assert.equal(registry.parentBranch, "crosby/001-example");
  assert.equal(registry.spaceId, "space-1");
  assert.equal(registry.queueState, "ready");
  assert.equal(registry.currentTask, null);
  assert.deepEqual(registry.tasks, {});
  assert.deepEqual(registry.workers, {});
});

test("atomically persists worker attempt and integration state", async () => {
  const store = await temporaryStore();
  await updateWorkerRecord(store, "COA-363", {
    lifecycle: "integrating",
    attemptCount: 1,
    integration: { outcome: "pending" },
  });
  await updateRegistry(store, (registry) => ({
    ...registry,
    workers: {
      ...registry.workers,
      "COA-363": { ...registry.workers["COA-363"], integration: { outcome: "merged" } },
    },
  }));

  const saved = await readRegistry(store);
  assert.deepEqual(saved.workers["COA-363"], {
    lifecycle: "integrating",
    attemptCount: 1,
    integration: { outcome: "merged" },
  });
  assert.doesNotMatch(await readFile(store.path, "utf8"), /\.tmp/);
});

test("serializes concurrent updates without losing records", async () => {
  const store = await temporaryStore();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      updateWorkerRecord(store, `COA-${index}`, { lifecycle: "working", attemptCount: index }),
    ),
  );

  const registry = await readRegistry(store);
  assert.equal(Object.keys(registry.workers).length, 8);
  assert.equal(registry.workers["COA-7"].attemptCount, 7);
});

test("lists worker records across parent registries", async () => {
  const first = await temporaryStore();
  const second = createRegistryStore({ root: first.root, repositoryIdentity: "file:///other", parentKey: "COA-361" });
  await updateWorkerRecord(first, "COA-363", { lifecycle: "running", registry: { taskKey: "COA-363" } });
  await updateWorkerRecord(second, "COA-364", { lifecycle: "running", registry: { taskKey: "COA-364" } });

  assert.deepEqual(
    (await listAllWorkers(first.root)).map((worker) => worker.registry.taskKey).sort(),
    ["COA-363", "COA-364"],
  );
});

test("rejects malformed persisted state instead of silently resetting it", async () => {
  const store = await temporaryStore();
  await mkdir(path.dirname(store.path), { recursive: true });
  await writeFile(store.path, JSON.stringify({ version: REGISTRY_VERSION, repositoryIdentity: store.repositoryIdentity, parentKey: store.parentKey, buildId: store.buildId, spaceId: store.spaceId, queueState: "working", currentTask: null, tasks: {}, workers: {} }));
  await assert.rejects(() => readRegistry(store), RegistryError);
});

test("recovers a stale lock and records a single same-worktree recovery", async () => {
  const store = await temporaryStore();
  await mkdir(path.dirname(store.lockPath), { recursive: true });
  await writeFile(store.lockPath, JSON.stringify({ createdAt: new Date(0).toISOString() }));
  await updateWorkerRecord(store, "COA-363", { lifecycle: "orphaned", attemptCount: 1 });
  const worker = await recordWorkerRecovery(store, "COA-363", "worker crashed");

  assert.equal(worker.recoveryAttempts, 1);
  assert.equal(worker.lifecycle, "launching");
  await assert.rejects(() => recordWorkerRecovery(store, "COA-363", "crashed again"), RegistryError);
});
