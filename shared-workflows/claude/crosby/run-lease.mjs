import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRegistryStore, updateRegistry } from './registry.mjs';

// Reuse the atomic registry mutation lock for lease ownership. A separate root
// keeps execution discovery from mistaking a lease record for a build registry.
export async function acquireRunLease({ root, repositoryIdentity, parentKey, buildId }) {
  const store = createRegistryStore({ root: path.join(root, 'run-leases'), repositoryIdentity, parentKey, buildId, spaceId: 'parent-wide' });
  const token = randomUUID();
  await updateRegistry(store, (registry) => {
    const owner = registry.activeRunLease;
    if (owner) {
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid Crosby run lease: ${store.path}`);
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`Crosby parent already running (PID ${owner.pid}). Let it finish or stop that run before resuming. Lease: ${store.path}`);
    }
    return { ...registry, activeRunLease: { pid: process.pid, token, startedAt: new Date().toISOString() } };
  });
  return async () => updateRegistry(store, (registry) => {
    if (registry.activeRunLease?.token !== token) throw new Error('Crosby run lease ownership changed; inspect before resuming.');
    return { ...registry, activeRunLease: null };
  });
}
