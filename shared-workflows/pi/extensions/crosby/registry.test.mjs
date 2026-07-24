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
} from "./registry.mjs";

async function temporaryStore() {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-registry-"));
  return createRegistryStore({ root, repositoryIdentity: "file:///repo", parentKey: "COA-360" });
}

test("creates a versioned registry keyed by repository identity and parent", async () => {
  const store = await temporaryStore();
  const registry = await readRegistry(store);

  assert.equal(registry.version, REGISTRY_VERSION);
  assert.equal(registry.repositoryIdentity, "file:///repo");
  assert.equal(registry.parentKey, "COA-360");
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
