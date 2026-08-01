import {
  collectChangedPaths,
  retainTaskFailure,
  runTaskVerification,
  safeCommit,
  serializedMerge,
  validateChangedPaths,
} from "./managed-git.mjs";

export class IntegrationError extends Error {
  constructor(message, retained) {
    super(`${message} Recovery: inspect the retained task worktree and branch; no PR was created.`);
    this.name = "IntegrationError";
    this.retained = retained;
  }
}

export async function integrateTask({ task, taskWorktree, parentWorktree, operations = {} } = {}) {
  if (!task?.id) throw new IntegrationError("Task ID is required for integration.");
  if (!taskWorktree?.path || !taskWorktree?.branch || !parentWorktree?.path) {
    throw new IntegrationError(`Task ${task.id} is missing managed worktree identity.`);
  }
  const ops = {
    collectChangedPaths,
    validateChangedPaths,
    runTaskVerification,
    safeCommit,
    serializedMerge,
    retainTaskFailure,
    ...operations,
  };
  const retained = () => ops.retainTaskFailure({ task: taskWorktree, reason: "Integration failed; retained for inspection." });
  try {
    const changedPaths = await ops.collectChangedPaths({ cwd: taskWorktree.path, baseSha: taskWorktree.baseSha });
    ops.validateChangedPaths(changedPaths, task.fileScope ?? task.fileScopes ?? []);
    const verification = await ops.runTaskVerification({ cwd: taskWorktree.path, verification: task.verification });
    const commit = await ops.safeCommit({ cwd: taskWorktree.path, message: `feat(crosby): complete ${task.id}` });
    const merge = await ops.serializedMerge({
      parentWorktreePath: parentWorktree.path,
      taskBranch: taskWorktree.branch,
      message: `Merge ${task.id} into ${parentWorktree.branch ?? "Crosby parent"}`,
    });
    return { taskId: task.id, changedPaths, verification, commit, merge };
  } catch (error) {
    const evidence = retained();
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError(error instanceof Error ? error.message : String(error), evidence);
  }
}
