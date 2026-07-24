import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const REGISTRY_VERSION = 1;

export class RegistryError extends Error {
  constructor(message) {
    super(`${message} Recovery: inspect the Crosby registry and retained task worktrees, correct the recorded state, then retry the supervisor.`);
    this.name = "RegistryError";
  }
}

function registryError(message) {
  throw new RegistryError(message);
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) registryError(`${name} must be a non-empty string.`);
  return text;
}

export function registryKey(repositoryIdentity, parentKey) {
  return createHash("sha256").update(`${requireText(repositoryIdentity, "repositoryIdentity")}\0${requireText(parentKey, "parentKey")}`).digest("hex");
}

export function createRegistryStore({ root, repositoryIdentity, parentKey, lockTimeoutMs = 10_000, staleLockMs = 120_000 } = {}) {
  const registryRoot = requireText(root, "root");
  const identity = requireText(repositoryIdentity, "repositoryIdentity");
  const parent = requireText(parentKey, "parentKey");
  const key = registryKey(identity, parent);
  const basePath = path.join(registryRoot, "registries", key);
  return {
    root: registryRoot,
    repositoryIdentity: identity,
    parentKey: parent,
    path: `${basePath}.json`,
    lockPath: `${basePath}.lock`,
    lockTimeoutMs,
    staleLockMs,
  };
}

function initialRegistry(store) {
  return {
    version: REGISTRY_VERSION,
    repositoryIdentity: store.repositoryIdentity,
    parentKey: store.parentKey,
    parent: null,
    workers: {},
  };
}

function validateRegistry(registry, store) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) registryError("Registry content must be a JSON object.");
  if (registry.version !== REGISTRY_VERSION) registryError(`Registry version must be ${REGISTRY_VERSION}.`);
  if (registry.repositoryIdentity !== store.repositoryIdentity || registry.parentKey !== store.parentKey) {
    registryError("Registry identity does not match the requested repository and parent.");
  }
  if (!registry.workers || typeof registry.workers !== "object" || Array.isArray(registry.workers)) {
    registryError("Registry workers must be an object keyed by child issue.");
  }
  return registry;
}

async function loadRegistry(store) {
  try {
    return validateRegistry(JSON.parse(await readFile(store.path, "utf8")), store);
  } catch (error) {
    if (error?.code === "ENOENT") return initialRegistry(store);
    if (error instanceof RegistryError) throw error;
    registryError(`Registry ${store.path} is unreadable or contains invalid JSON.`);
  }
}

export async function readRegistry(store) {
  return loadRegistry(store);
}

async function staleLock(lockPath, staleLockMs) {
  try {
    const payload = JSON.parse(await readFile(lockPath, "utf8"));
    const createdAt = Date.parse(payload?.createdAt);
    if (Number.isFinite(createdAt)) return Date.now() - createdAt > staleLockMs;
    return Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

async function acquireLock(store) {
  await mkdir(path.dirname(store.path), { recursive: true });
  const deadline = Date.now() + store.lockTimeoutMs;
  while (true) {
    try {
      const handle = await open(store.lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") registryError(`Could not acquire registry lock at ${store.lockPath}.`);
      if (await staleLock(store.lockPath, store.staleLockMs)) {
        await rm(store.lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) registryError(`Timed out waiting for registry lock at ${store.lockPath}.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function writeRegistry(store, registry) {
  const valid = validateRegistry(registry, store);
  const tempPath = `${store.path}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(valid, null, 2)}\n`;
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, store.path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function updateRegistry(store, updater) {
  if (typeof updater !== "function") registryError("Registry update requires an updater function.");
  await acquireLock(store);
  try {
    const current = await loadRegistry(store);
    const next = await updater(structuredClone(current));
    if (!next) registryError("Registry updater must return a registry record.");
    await writeRegistry(store, next);
    return next;
  } finally {
    await rm(store.lockPath, { force: true });
  }
}

export async function updateWorkerRecord(store, childKey, patch) {
  const key = requireText(childKey, "childKey");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) registryError("Worker update must be an object.");
  const registry = await updateRegistry(store, (current) => ({
    ...current,
    workers: { ...current.workers, [key]: { ...(current.workers[key] ?? {}), ...structuredClone(patch) } },
  }));
  return registry.workers[key];
}

export async function recordWorkerRecovery(store, childKey, note) {
  const key = requireText(childKey, "childKey");
  const recoveryNote = requireText(note, "recovery note");
  const registry = await updateRegistry(store, (current) => {
    const worker = current.workers[key];
    if (!worker) registryError(`Cannot recover unregistered worker ${key}.`);
    const attempts = Number(worker.recoveryAttempts ?? 0);
    if (attempts >= 1) registryError(`Worker ${key} has already used its one automatic same-worktree recovery.`);
    return {
      ...current,
      workers: {
        ...current.workers,
        [key]: {
          ...worker,
          lifecycle: "launching",
          recoveryAttempts: attempts + 1,
          recoveryNotes: [...(worker.recoveryNotes ?? []), recoveryNote],
        },
      },
    };
  });
  return registry.workers[key];
}
