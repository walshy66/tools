import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Registry identity survives moving the initiating Pi session to another workspace.
export async function resolveRegistrySpace({ root, repositoryIdentity, parentKey, buildId, workspace }) {
  let entries;
  try { entries = await readdir(path.join(root, 'registries')); }
  catch (error) { if (error.code === 'ENOENT') return workspace; throw error; }
  const matches = [];
  for (const filename of entries.filter((name) => name.endsWith('.json'))) {
    let registry;
    try { registry = JSON.parse(await readFile(path.join(root, 'registries', filename), 'utf8')); }
    catch { throw new Error(`Unreadable Crosby registry ${filename}; inspect it before selecting recovery state.`); }
    if (registry.repositoryIdentity === repositoryIdentity && registry.parentKey === parentKey && registry.buildId === buildId) matches.push(registry);
  }
  const used = matches.filter((registry) => Object.keys(registry.workers ?? {}).length || registry.parentVerification || registry.parentWorktree);
  if (used.length > 1) throw new Error('Multiple durable Crosby runs match this parent. Resolve which registry owns the work before resuming; none was discarded.');
  return used[0]?.spaceId ?? matches.find((registry) => registry.spaceId === workspace)?.spaceId ?? matches[0]?.spaceId ?? workspace;
}
