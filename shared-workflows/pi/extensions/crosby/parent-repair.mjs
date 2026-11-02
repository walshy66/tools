import { assertStableRevision } from './gate-stage.mjs';

export function createParentRepairPreparation(exec) {
  return async ({ worker, parentWorktree }) => {
    if (!worker?.taskWorktree?.path) throw new Error('Parent repair requires the retained child worktree.');
    const parentRevision = await assertStableRevision(exec, parentWorktree.path);
    await assertStableRevision(exec, worker.taskWorktree.path);
    // Child HEAD must be an ancestor of the integrated parent. Never reset or rebase user work.
    const merged = await exec('git', ['merge', '--ff-only', parentRevision], { cwd: worker.taskWorktree.path });
    if (merged.code !== 0) throw new Error(`Could not safely advance retained child to the combined parent. Inspect branch divergence; no reset was attempted. ${merged.stderr || merged.stdout}`);
    await assertStableRevision(exec, worker.taskWorktree.path, parentRevision);
    return { ...worker.taskWorktree, baseSha: parentRevision };
  };
}
