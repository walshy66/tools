import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectChangedPaths, retainTaskFailure, serializedMerge, validateChangedPaths } from './managed-git.mjs';
import { assertStableRevision } from './gate-stage.mjs';
import { contractHash, validateGateReport } from './quality-gates.mjs';
const execute = promisify(execFile);
async function exec(command, args, options) {
  try { const result = await execute(command, args, { ...options, windowsHide: true }); return { ...result, code: 0 }; }
  catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}

export class IntegrationError extends Error {
  constructor(message, retained) {
    super(`${message} Recovery: inspect the retained task worktree and gate reports; no PR was created.`);
    this.name = 'IntegrationError'; this.retained = retained;
  }
}

export async function integrateTask({ task, taskWorktree, parentWorktree, gates, operations = {} } = {}) {
  if (!task?.id || !taskWorktree?.path || !taskWorktree?.branch || !parentWorktree?.path) throw new IntegrationError('Missing task/worktree identity.');
  const ops = { collectChangedPaths, validateChangedPaths, serializedMerge, retainTaskFailure, assertStableRevision: (cwd, expected) => assertStableRevision(exec, cwd, expected), ...operations };
  try {
    if (task.contractError || !task.browserAcceptance || !task.reviewContext) throw new Error('Missing or invalid review/browser gate contract.');
    const hash = contractHash(task);
    if (gates?.outcome !== 'passed' || gates.contractHash !== hash || !gates.revision) throw new Error('Required revision-bound gates have not passed.');
    const revision = await ops.assertStableRevision(taskWorktree.path, gates.revision);
    if (revision !== gates.revision) throw new Error('Gate revision does not match task HEAD.');
    for (const stage of ['review', ...(task.browserAcceptance.required ? ['test'] : [])]) {
      const report = gates.reports?.find((entry) => entry.stage === stage);
      if (!report || report.outcome !== 'passed') throw new Error(`Missing passed ${stage} gate.`);
      validateGateReport(report, { runId: report.runId, stage, revision, contractHash: hash, commands: stage === 'review' ? task.verification.filter((item) => item.toLowerCase() !== 'none') : [], scenarios: stage === 'test' ? task.browserAcceptance.scenarios : [] });
    }
    const changedPaths = await ops.collectChangedPaths({ cwd: taskWorktree.path, baseSha: taskWorktree.baseSha });
    ops.validateChangedPaths(changedPaths, task.fileScope ?? task.fileScopes ?? []);
    // Never auto-commit verifier changes or blindly rerun shell commands after safe preflight.
    await ops.assertStableRevision(taskWorktree.path, revision);
    const merge = await ops.serializedMerge({ parentWorktreePath: parentWorktree.path, taskBranch: revision, message: `Merge ${task.id} into ${parentWorktree.branch ?? 'Crosby parent'}` });
    return { taskId: task.id, changedPaths, verification: gates.reports, commit: { committed: false, sha: revision }, merge };
  } catch (error) {
    const retained = ops.retainTaskFailure({ task: taskWorktree, reason: String(error.message ?? error) });
    throw new IntegrationError(error.message ?? String(error), retained);
  }
}
