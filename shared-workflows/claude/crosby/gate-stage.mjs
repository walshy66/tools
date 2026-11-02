import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractHash, validateGateReport } from './quality-gates.mjs';
import { readRegistry, updateRegistry } from './registry.mjs';
import { claudeLaunchCommand, prepareClaudeLaunch } from './claude-launch.mjs';

export async function assertStableRevision(exec, cwd, expected) {
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  const status = await exec('git', ['status', '--porcelain'], { cwd });
  if (head.code !== 0 || status.code !== 0 || status.stdout.trim()) throw new Error('Verification requires a clean, committed worktree; preserve changes and inspect it.');
  const revision = head.stdout.trim();
  if (expected && revision !== expected) throw new Error('Revision changed during verification; prior reports are invalid.');
  return revision;
}

export async function persistGateReport({ requestPath, report, pane, exec }) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  if (request.pane !== pane) throw new Error('Only the assigned independent verifier pane may report this gate.');
  const validated = validateGateReport({ ...report, runId: request.runId, stage: request.stage, revision: request.revision, contractHash: request.contractHash }, request);
  const receipt = await readGateEvidence(validated, request);
  await assertStableRevision(exec, request.cwd, request.revision);
  const submitted = { ...validated, submission: { pane, artifactHash: receipt, submittedAt: new Date().toISOString() } };
  await writeFile(request.resultPath, JSON.stringify(submitted, null, 2), { flag: 'wx' });
  return submitted;
}

async function readGateEvidence(validated, request) {
  const reportReal = await realpath(validated.reportPath);
  const artifactsReal = await realpath(request.artifactDir);
  const relative = path.relative(artifactsReal, reportReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Gate report must be inside its assigned artifact directory.');
  const evidence = await readFile(reportReal, 'utf8');
  if (!evidence.trim()) throw new Error('Gate report artifact is empty.');
  return createHash('sha256').update(evidence).digest('hex');
}

export async function validateSubmittedGateReport(report, request) {
  const validated = validateGateReport(report, request);
  if (validated.submission?.pane !== request.pane || !validated.submission?.submittedAt) throw new Error('Gate result lacks assigned-pane submission receipt.');
  if (await readGateEvidence(validated, request) !== validated.submission.artifactHash) throw new Error('Gate evidence changed after submission.');
  return validated;
}

export async function ensureGateAgentsSettled({ herdr, store, taskId }) {
  if (!store) return;
  const registry = await readRegistry(store);
  for (const gate of Object.values(registry.gateRuns ?? {})) {
    if (gate.taskId !== taskId || gate.lifecycle === 'reported') continue;
    if (!(gate.agent || gate.pane)) {
      if (!gate.artifactDir) throw new Error('Incomplete verifier launch record has no recovery evidence; inspect the registry before resuming.');
      try {
        const request = JSON.parse(await readFile(path.join(gate.artifactDir, 'request.json'), 'utf8'));
        if (request.task?.id !== taskId || !request.pane) throw new Error('Incomplete verifier launch identity.');
        gate.pane = request.pane;
      } catch (error) {
        // No request was published, so no verifier could have been started or prompted.
        if (error.code === 'ENOENT') continue;
        throw new Error(`Cannot recover verifier launch identity: ${error.message}`);
      }
    }
    let inspection;
    try { inspection = await herdr.inspectAgent({ agent: gate.agent ?? gate.pane }); }
    catch {
      const snapshot = await herdr.snapshot();
      if (gate.pane && !JSON.stringify(snapshot).includes(JSON.stringify(gate.pane))) continue;
      throw new Error(`Cannot establish whether retained verifier ${gate.agent ?? gate.pane} is stopped. Inspect its pane before retrying.`);
    }
    if (!['idle', 'done'].includes(inspection.state)) throw new Error(`Retained verifier ${gate.agent ?? gate.pane} is ${inspection.state}; settle or stop it before resuming.`);
  }
}

export function createGateStage({ herdr, exec, root, selectModel, onProgress, timeoutMs = 45 * 60_000, pollMs = 1000, signal, prepareLaunch = prepareClaudeLaunch }) {
  return async function runStage({ task, taskWorktree, worker, stage, store, build, expectedRevision }) {
    const runId = randomUUID();
    const artifactDir = path.join(root, 'gate-runs', runId);
    await mkdir(artifactDir, { recursive: true });
    const requestPath = path.join(artifactDir, 'request.json');
    let request;
    let verifier;
    const save = async (patch) => {
      if (store) await updateRegistry(store, (registry) => ({ ...registry, gateRuns: { ...registry.gateRuns, [runId]: { ...registry.gateRuns?.[runId], ...patch } } }));
    };
    try {
      if (signal?.aborted) throw new Error('Verification interrupted before launch; resume explicitly.');
      await ensureGateAgentsSettled({ herdr, store, taskId: task.id });
      if (!worker?.pane) throw new Error('No builder pane exists for an independent verifier sibling.');
      if (worker.agent) {
        const state = await herdr.waitForAgent({ agent: worker.agent, until: ['idle', 'done', 'blocked'], timeout: 30_000 });
        if (!['idle', 'done'].includes(state.state)) throw new Error('Builder has not settled; resolve its pending interaction before verification.');
      }
      const revision = await assertStableRevision(exec, taskWorktree.path, expectedRevision);
      const selection = await selectModel({ task: { ...task, title: `${stage === 'review' ? 'Code review' : 'Browser test'}: ${task.title}`, outcome: `Independently ${stage} the completed issue. ${task.outcome}`, role: stage }, build, role: stage });
      const sharedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
      const manifest = JSON.parse(await readFile(path.join(sharedRoot, 'manifest.json'), 'utf8'));
      const skillName = stage === 'review' ? 'code-reviewer' : 'tester';
      const skillPath = path.resolve(sharedRoot, '..', manifest.portable.skills[skillName]);
      await readFile(skillPath, 'utf8');
      request = {
        runId, stage, revision, contractHash: contractHash(task), cwd: taskWorktree.path, baseSha: taskWorktree.baseSha,
        task, commands: stage === 'review' ? (task.verification ?? []).filter((item) => item.toLowerCase() !== 'none') : [],
        scenarios: stage === 'test' ? task.browserAcceptance.scenarios : [],
        artifactDir, resultPath: path.join(artifactDir, 'result.json'), skillPath,
      };
      await save({ taskId: task.id, stage, revision, artifactDir, lifecycle: 'launching', createdAt: new Date().toISOString() });
      if (signal?.aborted) throw new Error('Verification interrupted before pane creation; resume explicitly.');
      verifier = await herdr.createVerifierPane({ pane: worker.pane, cwd: taskWorktree.path, env: { CROSBY_GATE_REQUEST: requestPath } });
      request.pane = verifier.pane;
      await writeFile(requestPath, JSON.stringify(request, null, 2), { flag: 'wx' });
      await save({ ...verifier, lifecycle: 'launching' });
      const name = `cg-${stage}-${runId.slice(0, 12)}`;
      const launch = await prepareLaunch({ root, name, mode: 'gate', context: { requestPath, pane: verifier.pane } });
      const started = await herdr.startClaudeAgent({ pane: verifier.pane, name, command: claudeLaunchCommand({ model: selection.model, effort: selection.thinking, mcpConfig: launch.mcpConfig, settings: launch.settings, name }) });
      verifier.agent = started.name;
      await save({ ...verifier, lifecycle: 'working', modelSelection: selection });
      await onProgress?.({ taskId: task.id, stage, summary: `${stage === 'review' ? 'reviewing code' : 'testing browser scenarios'}`, artifactDir });
      const prompt = [
        `You are an independent Crosby ${skillName} for ${task.sourceIssue ?? task.id}. You did not implement this work.`,
        `Read the complete request at ${requestPath}, then load and follow ${skillPath}.`,
        `Repository: ${request.cwd}. Base: ${request.baseSha}. Exact revision: ${revision}.`,
        'Read the applicable repository AGENTS.md chain, constitution, approved decisions and testing instructions. Do not load an unrelated shared constitution.',
        'Remain report-only. Never modify implementation/tests/criteria, commit, merge, publish issues, or control other agents. The builder must remain idle.',
        'Inspect command side effects and environment ownership before executing. Missing authorisation or safe prerequisites is blocked, never bypass guards.',
        `Write sanitised Markdown evidence inside ${artifactDir}. Only temporary artifacts belong there.`,
        'Run repository-required checks and the declared commands where safe. Required checks may not be skipped. Treat none as no issue-specific command, not a waiver of repository gates.',
        'Finish with crosby_gate_report. Map APPROVED/PASS to passed, CHANGES REQUIRED/FAIL to changes-required, and BLOCKED to blocked.',
        'Only set repairable true for a concrete defect within approved scope/file boundaries. Ambiguous requirements, unsafe setup and scope changes need a human action, not automatic repair.',
        'Include all declared command and prescribed scenario results. For browser passes include proven runtime provenance and cleanup passed. Never claim browser acceptance from source inspection.',
        'Your report ends the turn; do not continue working after reporting.',
      ].join('\n');
      await herdr.promptAgent({ agent: started.name, prompt, wait: false });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Gate interrupted; inspect retained verifier and resume explicitly.');
        let report;
        try { report = JSON.parse(await readFile(request.resultPath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (report) {
          const settled = await herdr.waitForAgent({ agent: started.name, until: ['idle', 'done'], timeout: 30_000 });
          if (!['idle', 'done'].includes(settled.state)) throw new Error('Verifier has not settled; report cannot complete the gate.');
          await assertStableRevision(exec, request.cwd, revision);
          const result = await validateSubmittedGateReport(report, request);
          await save({ lifecycle: 'reported', report: result, completedAt: new Date().toISOString() });
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw new Error('Verifier report timed out; inspect the retained pane and environment, then resume.');
    } catch (error) {
      // Retain panes and worktrees; never silently terminate or discard uncertain work.
      const summary = error instanceof Error ? error.message : String(error);
      await save({ lifecycle: 'blocked', summary, ...verifier });
      return { outcome: 'blocked', summary, requiredHumanAction: `${summary} Evidence: ${artifactDir}. Stop any still-active verifier before resuming.`, artifactDir };
    }
  };
}
