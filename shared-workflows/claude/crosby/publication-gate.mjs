import { assertStableRevision } from './gate-stage.mjs';
import { buildContractHash } from './quality-gates.mjs';

export async function verifiedPublicationTarget({ state, branch, exec }) {
  const { registry, build } = state;
  const gate = registry.parentVerification;
  if (!registry.readyForReview || gate?.outcome !== 'passed' || build.contractError || build.tasks.some((task) => task.contractError) || gate.buildContractHash !== buildContractHash(build)) throw new Error('Parent gates have not passed for the current issue contracts. Resume verification before publishing.');
  const cwd = registry.parentWorktree?.path;
  if (!cwd) throw new Error('Missing retained parent worktree for publication.');
  const revision = await assertStableRevision(exec, cwd, gate.revision);
  const ref = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd });
  if (ref.code !== 0 || ref.stdout.trim() !== branch) throw new Error('Publication branch does not match the verified parent worktree. No checkout or push was performed.');
  return { cwd, revision, branch };
}
