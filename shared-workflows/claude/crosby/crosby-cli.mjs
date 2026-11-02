#!/usr/bin/env node
// Claude Code entry point for Crosby: the supervisor that index.ts runs inside Pi,
// as a standalone Node process started in the background by the /crosby command.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publishParentPullRequest } from './lib-v2.mjs';
import { createHerdrClient } from './herdr-client.mjs';
import { createHerdrCliInvoker } from './herdr-cli.mjs';
import { requireCrosbyHerdrContext } from './herdr-context.mjs';
import { formatBuildProgress, loadBuild, parseBuildCommandArgs, readBuildStatus, runBuild } from './build-runner.mjs';
import { createRegistryStore, readRegistry, updateRegistry } from './registry.mjs';
import { resolveRegistrySpace } from './registry-discovery.mjs';
import { integrateTask } from './integration.mjs';
import { createGitHubClient } from './github-client.mjs';
import { writeGitHubBuild, renderGitHubBuild } from './github-build.mjs';
import { parseBuildTaskList } from './task-list.mjs';
import { buildGitHubChildProgress, buildGitHubParentSummary } from './github-reporting.mjs';
import { parseGitHubCommand } from './github-actions.mjs';
import { ensureDashboardPane } from './dashboard-launch.mjs';
import { createGateStage, ensureGateAgentsSettled } from './gate-stage.mjs';
import { runTaskGates } from './gate-runner.mjs';
import { createParentVerifier } from './parent-gates.mjs';
import { acknowledgeManualAction } from './manual-recovery.mjs';
import { createProgressNotifier, oneLine } from './progress-notifier.mjs';
import { createParentRepairPreparation } from './parent-repair.mjs';
import { buildContractHash } from './quality-gates.mjs';
import { verifiedPublicationTarget } from './publication-gate.mjs';
import { normalizeRepositoryUrl } from './github-source.mjs';
import {
  createCrosbyDashboard, markDashboardExecutionStarted, markDashboardExecutionFinished, markDashboardExecutionFinalized,
  markDashboardHerdrWorkerStarted, markDashboardPaneOpened, markDashboardQualityStage, markDashboardFatalError,
  reconcileDashboardFromQueue, persistDashboardEvent,
} from './dashboard.mjs';
import { CLAUDE_CROSBY_ROOT, claudeLaunchCommand, prepareClaudeLaunch, resolveClaudeModel } from './claude-launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const registryRoot = CLAUDE_CROSBY_ROOT;
const buildRoot = path.join(registryRoot, 'github-builds');
const execute = promisify(execFile);

export async function exec(command, args, options = {}) {
  try {
    const result = await execute(command, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? '', code: typeof error.code === 'number' ? error.code : 1 };
  }
}

function say(line, level = 'info') {
  process.stdout.write(`[crosby${level === 'info' ? '' : `:${level}`}] ${oneLine(line, 400)}\n`);
}

function sessionLogPath(pane) {
  return path.join(registryRoot, 'sessions', `${createHash('sha256').update(String(pane)).digest('hex').slice(0, 16)}.jsonl`);
}

async function appendEntry(pane, kind, data) {
  const file = sessionLogPath(pane);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ kind, at: new Date().toISOString(), data })}\n`);
}

const ghCommand = () => process.env.GH_BIN?.trim() || 'gh';
const gitCommand = () => process.env.GIT_BIN?.trim() || 'git';

async function checked(result, message) {
  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(details ? `${message} ${details}` : `${message} Exit code: ${result.code}.`);
  }
  return result;
}

async function resolveRepositoryIdentity(cwd) {
  const remote = await exec(gitCommand(), ['-C', cwd, 'remote', 'get-url', 'origin'], { cwd });
  return remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : path.resolve(cwd);
}

function issueNumberForTask(task) {
  if (task?.sourceIssue) return String(task.sourceIssue).match(/\d+/)?.[0] ?? String(task.sourceIssue);
  return String(task?.id ?? '').replace(/^task-0*/, '');
}

function isStandaloneParentTask(task, queue) {
  if (task?.standaloneParentTask === true) return true;
  const issueNumber = issueNumberForTask(task);
  return queue?.standaloneParentTask === true
    && queue?.children?.some((child) => child?.standaloneParentTask === true && String(child?.number) === issueNumber);
}

function queueWithStandaloneTaskState(queue, stateName) {
  if (!queue?.standaloneParentTask) return queue;
  const state = stateName === 'Done' ? { name: 'Done', type: 'completed' } : { name: stateName, type: 'started' };
  const children = (queue.children ?? []).map((child) => child?.standaloneParentTask ? { ...child, state } : child);
  return { ...queue, parent: { ...queue.parent, children }, children };
}

function createDashboardController(queue, mode) {
  const dashboard = createCrosbyDashboard(queue, { mode });
  const render = () => { try { persistDashboardEvent(dashboard); } catch { /* best effort */ } };
  render();
  return {
    get dashboard() { return dashboard; },
    paneOpened(event) { markDashboardPaneOpened(dashboard, event); render(); },
    qualityStage(event) { markDashboardQualityStage(dashboard, event); render(); },
    executionStarted(event) { markDashboardExecutionStarted(dashboard, event); render(); },
    workerStarted(event) { markDashboardHerdrWorkerStarted(dashboard, event); render(); },
    executionFinished(event) { markDashboardExecutionFinished(dashboard, event); render(); },
    executionFinalized(event) { markDashboardExecutionFinalized(dashboard, event); render(); },
    queueRefreshed(nextQueue) { reconcileDashboardFromQueue(dashboard, nextQueue); render(); },
    fatal(error) { markDashboardFatalError(dashboard, error); render(); },
  };
}

async function openDashboardPane(controller, sourcePath) {
  if (!controller || controller.dashboard.dashboardPaneId || process.env.CROSBY_DASHBOARD_PANE === '0') return;
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID) return;
  try {
    const { paneId } = await ensureDashboardPane({
      exec: (command, args) => exec(command, args),
      paneId: process.env.HERDR_PANE_ID,
      sourcePath,
      nodePath: process.execPath,
      runnerPath: path.join(here, 'dashboard-runner.mjs'),
      runId: controller.dashboard.runId,
    });
    controller.paneOpened({ paneId });
  } catch (error) {
    controller.fatal(error);
  }
}

// One supervisor per trigger pane, like the Pi session guard: a running build rejects a
// second invocation; an idle queue monitor is stopped before an explicit replacement.
async function claimSupervisorSlot(pane, parent) {
  const file = path.join(registryRoot, 'supervisors', `${createHash('sha256').update(String(pane)).digest('hex').slice(0, 16)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  let current = null;
  try { current = JSON.parse(await readFile(file, 'utf8')); } catch { current = null; }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  if (current?.pid && current.pid !== process.pid && alive(current.pid)) {
    if (current.state !== 'monitoring') throw new Error(`Crosby supervision is already running from this pane (PID ${current.pid}, ${current.parent ?? 'unknown parent'}). Let it settle; the dashboard shows progress.`);
    say(`Stopping idle queue monitor for ${current.parent} (PID ${current.pid}) before replacing it.`);
    try { process.kill(current.pid); } catch { /* already gone */ }
    for (let i = 0; i < 50 && alive(current.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    if (alive(current.pid)) throw new Error(`Previous Crosby monitor (PID ${current.pid}) did not stop; stop it before rerunning.`);
  }
  const write = (state) => writeFile(file, JSON.stringify({ pid: process.pid, parent, state, updatedAt: new Date().toISOString() }));
  await write('running');
  return {
    set: write,
    release: async () => {
      try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.pid === process.pid) await rm(file, { force: true }); } catch { /* gone */ }
    },
  };
}

function createHerdrForCli() {
  return createHerdrClient({
    invoke: createHerdrCliInvoker({ exec: (name, herdrArgs) => exec(name, herdrArgs) }),
    onStartupDialog: ({ message }) => say(message, 'warning'),
  });
}

function selectRoleModel({ task, role }) {
  const roleEnv = role === 'test' ? 'TESTER' : role === 'review' ? 'REVIEWER' : null;
  const configured = roleEnv ? process.env[`CROSBY_${roleEnv}_MODEL`] : null;
  const configuredThinking = roleEnv ? process.env[`CROSBY_${roleEnv}_THINKING`] : null;
  const selection = resolveClaudeModel({ modelHint: configured || task.modelHint, thinkingHint: configuredThinking || task.thinkingHint });
  return configured && selection.source === 'issue-label' ? { ...selection, source: 'role-config' } : selection;
}

async function loadStoreForParent({ githubQueue, sourcePath, identity, workspace }) {
  const folder = await writeGitHubBuild(githubQueue, buildRoot);
  const build = await loadBuild(folder);
  const spaceId = await resolveRegistrySpace({ root: registryRoot, repositoryIdentity: identity, parentKey: build.parentBranch, buildId: build.buildId, workspace });
  return createRegistryStore({ root: registryRoot, repositoryIdentity: identity, parentKey: build.parentBranch, buildId: build.buildId, buildFolder: build.folder, parentBranch: build.parentBranch, spaceId });
}

// Equivalent of the Pi crosby_review_complete tool.
async function runDone(tokens) {
  const [parentRef, childRef] = tokens;
  if (!parentRef) throw new Error('Usage: /crosby done #parent [#child]');
  const sourcePath = process.cwd();
  const identity = await resolveRepositoryIdentity(sourcePath);
  const herdrContext = requireCrosbyHerdrContext();
  const client = createGitHubClient({ repository: identity, exec: (name, args) => exec(name, args, { cwd: sourcePath }) });
  const queue = await client.loadParentQueue(parentRef);
  const candidates = queue.children.filter((child) => child.state.name === 'Review');
  const selected = childRef ? candidates.find((child) => String(child.number) === childRef.replace(/^#/, '')) : candidates.length === 1 ? candidates[0] : null;
  if (!selected) throw new Error('Specify the child issue requiring assistance; do not guess among multiple waiting tasks. Use /crosby resume #parent for parent integration blockers.');
  const store = await loadStoreForParent({ githubQueue: queue, sourcePath, identity, workspace: herdrContext.workspace });
  const taskId = `task-${String(selected.number).padStart(3, '0')}`;
  const { manualOnly, task } = await acknowledgeManualAction({ store, taskId });
  if (manualOnly && !isStandaloneParentTask(task, queue)) await client.moveIssue(selected.number, 'Done');
  else await client.moveIssue(selected.number, 'Ready to Build');
  await client.addComment(selected.number, 'Operator acknowledged manual assistance. Code-bearing work will resume through all required verification gates; the parent remains open.');
  say(`#${selected.number}: assistance recorded. A running Crosby monitor resumes within its next poll; otherwise run /crosby resume ${queue.parent.identifier}. No gates were bypassed.`, 'success');
}

async function openClaudePane({ herdr, cwd, env = {} }) {
  const source = process.env.HERDR_PANE_ID;
  if (!source) throw new Error('Run this from a Herdr pane.');
  return herdr.createVerifierPane({ pane: source, cwd, env });
}

async function defaultBase(cwd) {
  const head = await exec(gitCommand(), ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd });
  const target = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'origin/main';
  const base = await exec(gitCommand(), ['merge-base', 'HEAD', target], { cwd });
  return base.code === 0 ? { ref: target, sha: base.stdout.trim() } : { ref: 'HEAD', sha: null };
}

// /reviewer: an ad-hoc, report-only Claude code review in a sibling Herdr pane.
async function runReviewer(tokens, herdr) {
  const baseIndex = tokens.indexOf('--base');
  const baseArg = baseIndex >= 0 ? tokens[baseIndex + 1] : null;
  const focus = tokens.filter((_, index) => baseIndex < 0 || (index !== baseIndex && index !== baseIndex + 1)).join(' ').trim();
  const top = await checked(await exec(gitCommand(), ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }), 'Run /reviewer inside a git repository.');
  const cwd = path.resolve(top.stdout.trim());
  const head = (await checked(await exec(gitCommand(), ['rev-parse', 'HEAD'], { cwd }), 'Cannot read HEAD.')).stdout.trim();
  const dirty = Boolean((await exec(gitCommand(), ['status', '--porcelain'], { cwd })).stdout.trim());
  const base = baseArg
    ? { ref: baseArg, sha: (await checked(await exec(gitCommand(), ['rev-parse', baseArg], { cwd }), `Unknown base ${baseArg}.`)).stdout.trim() }
    : await defaultBase(cwd);
  const runId = randomUUID();
  const artifactDir = path.join(registryRoot, 'reviews', runId);
  await mkdir(artifactDir, { recursive: true });
  const resultPath = path.join(artifactDir, 'result.json');
  const manifest = JSON.parse(await readFile(path.resolve(here, '../..', 'manifest.json'), 'utf8'));
  const skillPath = path.resolve(here, '../../..', manifest.portable.skills['code-reviewer']);
  await readFile(skillPath, 'utf8');
  const selection = resolveClaudeModel({ modelHint: process.env.CROSBY_REVIEWER_MODEL, thinkingHint: process.env.CROSBY_REVIEWER_THINKING });
  const name = `reviewer-${runId.slice(0, 8)}`;
  const pane = await openClaudePane({ herdr, cwd });
  const launch = await prepareClaudeLaunch({ root: registryRoot, name, mode: 'adhoc', context: { artifactDir, resultPath, cwd, head, base, dirty } });
  const started = await herdr.startClaudeAgent({ pane: pane.pane, name, command: claudeLaunchCommand({ model: selection.model, effort: selection.thinking, mcpConfig: launch.mcpConfig, settings: launch.settings, name }) });
  say(`Reviewer ${started.name} (${selection.model}) opened in pane ${pane.pane}; reviewing ${base.ref}${base.sha ? ` (${base.sha.slice(0, 12)})` : ''}..${head.slice(0, 12)}${dirty ? ' plus uncommitted changes' : ''}.`);
  const prompt = [
    'You are an independent Crosby code reviewer. You did not write this code.',
    `Load and follow the code-reviewer skill at ${skillPath}.`,
    `Repository: ${cwd}. Review the changes from ${base.sha ?? base.ref} (${base.ref}) to HEAD ${head}${dirty ? ', plus the uncommitted working-tree changes (git diff HEAD and untracked files)' : ''}.`,
    ...(focus ? [`Operator focus: ${focus}`] : []),
    'Read the applicable repository AGENTS.md/CLAUDE.md chain, constitution, approved decisions and testing instructions before judging.',
    'Remain report-only. Never modify implementation, tests or criteria; never commit, push, merge, or change issues/PRs.',
    'Inspect command side effects and environment ownership before executing anything. Run repository-defined checks only where safe; otherwise record them as not run with the reason.',
    `Write your sanitised Markdown report inside ${artifactDir} (for example ${path.join(artifactDir, 'review.md')}). Only report artifacts belong there.`,
    'Finish with the crosby_gate_report tool: map APPROVED to passed, CHANGES REQUIRED to changes-required and BLOCKED to blocked; include checks run (scenarios may be empty), safety, repairable and requiredHumanAction.',
    'After reporting, stop. The operator may ask follow-up questions in this pane; answer them read-only.',
  ].join('\n');
  await herdr.promptAgent({ agent: started.name, prompt, wait: false });
  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    let result = null;
    try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (result) {
      say(`Review ${result.outcome}: ${result.summary}`, result.outcome === 'passed' ? 'success' : 'warning');
      if (result.requiredHumanAction) say(`Action: ${result.requiredHumanAction}`, 'warning');
      say(`Report: ${result.reportPath}. The reviewer pane ${pane.pane} stays open for follow-up questions.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Reviewer did not report within one hour; inspect pane ${pane.pane}. Evidence: ${artifactDir}`);
}

async function runCrosby(args, { controller, slot }) {
  let command;
  let statusArgs;
  let githubClient;
  let githubQueue;
  let dashboardController;
  let durableBuildRunning = false;
  let monitorStop = null;
  const notify = createProgressNotifier((line, level) => say(line, level));
  const githubCommand = parseGitHubCommand(args);
  const watchMode = githubCommand?.mode === 'watch';
  let githubIssue = ['parent', 'resume', 'review'].includes(githubCommand?.mode ?? '') ? githubCommand.issueRef : null;
  const sourcePath = process.cwd();
  const identity = await resolveRepositoryIdentity(sourcePath);
  const herdrContext = requireCrosbyHerdrContext();
  const record = (kind, data) => appendEntry(herdrContext.pane, kind, data).catch(() => {});
  const githubFor = () => createGitHubClient({ repository: identity, exec: (name, ghArgs) => exec(name, ghArgs, { cwd: sourcePath }) });
  try {
    if (watchMode) {
      githubClient = githubFor();
      const queues = await githubClient.loadExecuteParentQueues();
      githubQueue = queues.find((queue) => !queue.children.some((child) => child.state.name === 'Building'));
      if (!githubQueue) { say('Crosby watch cycle is idle; no runnable GitHub parent was found.'); return; }
      githubIssue = githubQueue.parent.identifier;
    }
    if (githubCommand?.mode === 'push') {
      githubClient = githubFor();
      githubQueue = await githubClient.loadParentQueue(githubCommand.issueRef);
      const folder = await writeGitHubBuild(githubQueue, buildRoot);
      const state = await readBuildStatus({ buildFolder: folder, sourcePath, workspace: herdrContext.workspace, registryRoot, repositoryIdentity: identity });
      const target = await verifiedPublicationTarget({ state, branch: githubQueue.parent.branchName, exec });
      const repository = normalizeRepositoryUrl(identity).replace(/^https:\/\/github\.com\//, '');
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Cannot resolve an explicit GitHub repository for publication.');
      const gh = (ghArgs, cwd) => exec(ghCommand(), [...ghArgs, '--repo', repository], { cwd });
      const getPullRequest = async ({ branchName, cwd, allowMissing }) => {
        const result = await gh(['pr', 'view', ...(branchName ? [branchName] : []), '--json', 'number,url,body,headRefName'], cwd);
        if (result.code !== 0) {
          if (allowMissing && /no pull requests found for branch/i.test(`${result.stderr}\n${result.stdout}`)) return null;
          await checked(result, `Failed to load pull request details for branch ${branchName ?? 'current'}.`);
        }
        return JSON.parse(result.stdout);
      };
      const operations = {
        routing: { cwd: target.cwd },
        ensureParentBranch: async () => { await verifiedPublicationTarget({ state, branch: target.branch, exec }); },
        assertCleanWorkingTree: async () => { await verifiedPublicationTarget({ state, branch: target.branch, exec }); },
        readImplementationSummary: async () => `${buildGitHubParentSummary({ parent: githubQueue.parent, children: githubQueue.children })}\n\nVerified revision: ${target.revision}. Required code/browser and combined-parent checks passed. Parent remains open for human review.`,
        pushBranch: async () => {
          await verifiedPublicationTarget({ state, branch: target.branch, exec });
          await checked(await exec(gitCommand(), ['push', identity, `${target.revision}:refs/heads/${target.branch}`], { cwd: target.cwd }), `Git push failed in ${target.cwd}.`);
        },
        getPullRequest,
        createPullRequest: async ({ title, body, branchName, cwd }) => {
          await checked(await gh(['pr', 'create', ...(branchName ? ['--head', branchName] : []), '--title', title, '--body', body], cwd), `Failed to create pull request for branch ${branchName ?? 'current'}.`);
          const pullRequest = await getPullRequest({ branchName, cwd, allowMissing: false });
          if (!pullRequest) throw new Error(`Pull request creation reported success but no PR was found for branch ${branchName ?? 'current'}.`);
          return pullRequest;
        },
        updatePullRequest: async ({ prNumber, body, cwd }) => { await checked(await gh(['pr', 'edit', String(prNumber), '--body', body], cwd), `Failed to update PR #${prNumber} description.`); },
        addParentComment: (key, body) => githubClient.addComment(key, body),
      };
      const result = await publishParentPullRequest(githubQueue.standaloneParentTask ? queueWithStandaloneTaskState(githubQueue, 'Done') : githubQueue, [], operations);
      say(`Crosby push completed for ${githubQueue.parent.identifier}: ${result?.url ?? result?.pullRequest?.url ?? 'done'}.`, 'success');
      return;
    }
    if (githubIssue) {
      githubClient = githubFor();
      githubQueue = await githubClient.loadParentQueue(githubIssue);
      const buildFolder = await writeGitHubBuild(githubQueue, buildRoot);
      command = parseBuildCommandArgs(`${['resume', 'review'].includes(githubCommand?.mode ?? '') ? 'resume' : 'run'} ${buildFolder}`);
    } else {
      command = parseBuildCommandArgs(args);
    }
    if (githubQueue) {
      dashboardController = createDashboardController(githubQueue, 'manual');
      await openDashboardPane(dashboardController, sourcePath);
      const firstActiveChild = githubQueue.children.find((child) => !['Done', 'Review'].includes(child.state?.name));
      if (firstActiveChild) dashboardController.executionStarted({ child: firstActiveChild, parent: githubQueue.parent });
    }
    const herdr = createHerdrForCli();
    statusArgs = { buildFolder: command.buildFolder, sourcePath, workspace: herdrContext.workspace, registryRoot, repositoryIdentity: identity };
    if (command.mode === 'status') {
      const status = await readBuildStatus(statusArgs);
      say(formatBuildProgress(status.progress));
      return;
    }
    const waitForReport = async ({ task, store }) => {
      const deadline = Date.now() + 60 * 60_000;
      while (Date.now() < deadline) {
        if (controller.signal.aborted) throw new Error('Crosby interrupted; retained work can be resumed explicitly.');
        const worker = (await readRegistry(store)).workers?.[task.id];
        if (worker?.report && ['complete', 'blocked', 'failed', 'cancelled'].includes(worker.report.outcome)) return worker.report;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`Builder #${issueNumberForTask(task)} did not submit a report within one hour. Inspect retained pane and resume explicitly.`);
    };
    let parentClaimed = false;
    const selectModel = async ({ task, role }) => {
      const selection = selectRoleModel({ task, role });
      await record('crosby-worker-model-selected', { taskId: task.id, role: role || 'builder', ...selection });
      return selection;
    };
    const gateStage = createGateStage({ herdr, exec, root: registryRoot, selectModel, signal: controller.signal, onProgress: async (event) => {
      await record('crosby-gate-progress', event);
      dashboardController?.qualityStage(event);
      notify(`Crosby ${githubQueue?.parent?.identifier ?? ''} · ${event.taskId} ${event.summary}`);
    } });
    const buildAdapters = {
      herdrClient: herdr,
      selectTaskModel: selectModel,
      verifyTask: (input) => runTaskGates({ ...input, stage: gateStage }),
      verifyParent: createParentVerifier({ herdr, stage: gateStage, exec }),
      prepareParentRepair: createParentRepairPreparation(exec),
      beforeTaskResume: ({ task, store }) => ensureGateAgentsSettled({ herdr, store, taskId: task.id }),
      waitForReport,
      integrateTask: (input) => integrateTask(input),
      onTaskStarting: async ({ task }) => {
        if (controller.signal.aborted) throw new Error('Crosby interrupted before worker launch.');
        if (!githubClient) return;
        if (!parentClaimed && githubQueue?.parent) {
          await githubClient.moveIssue(githubQueue.parent.identifier, 'Building');
          parentClaimed = true;
        }
        const issueNumber = issueNumberForTask(task);
        if (!isStandaloneParentTask(task, githubQueue)) {
          const latest = await githubClient.loadIssue(issueNumber, { includeChildren: false });
          if (latest.state.name === 'Done') await githubClient.reopenIssue(issueNumber);
          await githubClient.moveIssue(issueNumber, 'Building');
        }
        dashboardController?.executionStarted({ child: { identifier: `#${issueNumber}`, title: task.title }, parent: githubQueue?.parent });
      },
      onTaskIntegrated: async ({ task, report }) => {
        const issueNumber = issueNumberForTask(task);
        dashboardController?.executionFinished({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'done', summary: report.summary } });
        dashboardController?.executionFinalized({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'done', summary: report.summary } });
        if (githubClient) {
          if (!isStandaloneParentTask(task, githubQueue)) await githubClient.moveIssue(issueNumber, 'Done');
          await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: report.outcome, summary: report.summary, changes: report.changes?.paths ?? [report.changes?.commit ?? 'recorded in the durable worktree'], verification: report.verification?.map((entry) => `${entry.command}: ${entry.result}`), recoveryNotes: report.risks }));
        }
      },
      onTaskReview: async ({ task, report }) => {
        const issueNumber = issueNumberForTask(task);
        dashboardController?.executionFinalized({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'review', summary: report.summary, requiredHumanAction: report.requiredHumanAction, recoveryNotes: report.recoveryNotes } });
        dashboardController?.qualityStage({ taskId: task.id, stage: 'blocked', summary: report.summary, requiredHumanAction: report.requiredHumanAction, artifactDir: report.artifactDir ?? report.reports?.[0]?.reportPath });
        if (githubClient) {
          await githubClient.moveIssue(issueNumber, 'Review');
          await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: 'review', summary: report.summary, recoveryNotes: [report.requiredHumanAction, ...(report.recoveryNotes ?? [])] }));
        }
      },
      onProgress: async (progress) => {
        await record('crosby-build-progress', progress);
        notify(formatBuildProgress(progress));
      },
      emitLifecycle: (event) => {
        if (event.lifecycle === 'working') {
          const issueNumber = String(event.taskId ?? '').replace(/^task-0*/, '');
          dashboardController?.workerStarted({ ...event, taskId: issueNumber ? `#${issueNumber}` : event.taskId });
        }
        record('crosby-worker-lifecycle', event);
      },
    };
    const runDurableBuild = async (buildFolder, resume = false) => {
      controller.signal.throwIfAborted();
      if (durableBuildRunning) return null;
      durableBuildRunning = true;
      await slot.set('running');
      dashboardController?.qualityStage({ taskId: null, stage: 'running', summary: 'Evaluating current contracts and gates; not ready until verification completes.' });
      try {
        const result = await runBuild({ buildFolder, sourcePath, workspace: herdrContext.workspace, pane: herdrContext.pane, agent: process.env.HERDR_AGENT_NAME || 'crosby-supervisor', registryRoot, repositoryIdentity: identity, resume, adapters: buildAdapters });
        controller.signal.throwIfAborted();
        if (result.readyForReview && githubClient && githubQueue) {
          const latest = await githubClient.loadParentQueue(githubQueue.parent.identifier);
          const approved = (await readRegistry(result.registry)).parentVerification;
          if (buildContractHash(parseBuildTaskList(renderGitHubBuild(latest))) !== approved?.buildContractHash) {
            result.readyForReview = false;
            result.blockers.push({ taskId: null, outcome: 'blocked', summary: 'Issue contracts changed during execution; previous approval is stale.', requiredHumanAction: `Confirm updated scope and run /crosby resume ${latest.parent.identifier}.` });
            await updateRegistry(result.registry, (registry) => ({ ...registry, readyForReview: false, blockers: result.blockers }));
          }
        }
        dashboardController?.qualityStage({ taskId: null, stage: result.readyForReview ? 'ready' : 'blocked', summary: result.readyForReview ? `All gates passed. Review worktree: ${result.parent.path}; parent remains open.` : result.blockers.map((item) => `${item.taskId ?? 'parent'}: ${item.summary}`).join('; '), requiredHumanAction: result.readyForReview ? 'Review the complete experience and manually close the parent.' : result.blockers.map((item) => item.requiredHumanAction).filter(Boolean).join('; ') });
        if (githubClient && githubQueue) {
          const summary = result.readyForReview
            ? `Ready for human review. All child and combined-parent gates passed. Review worktree: ${result.parent.path}. Follow repository review/startup instructions. Parent stays open for the operator to close.`
            : `Not ready for review.\n${result.blockers.map((item) => `${item.taskId ?? 'parent'}: ${item.summary}\nAssistance: ${item.requiredHumanAction ?? 'Inspect retained evidence.'}`).join('\n')}\nResume: /crosby resume ${githubQueue.parent.identifier}`;
          await githubClient.addComment(githubQueue.parent.identifier, summary);
          await githubClient.moveIssue(githubQueue.parent.identifier, result.readyForReview ? 'Review' : 'Building');
          notify(`Crosby ${githubQueue.parent.identifier} · ${result.readyForReview ? 'ready for your review — parent remains open' : `not ready: ${result.blockers[0]?.summary ?? 'verification incomplete'} — see dashboard/action report`}`, result.readyForReview ? 'success' : 'warning');
        }
        return result;
      } finally {
        durableBuildRunning = false;
        await slot.set('monitoring');
      }
    };
    // GitHub contract/status changes (for example /crosby done) resume waiting work while this process lives.
    const startQueueMonitor = () => new Promise((resolve) => {
      let stopped = false;
      let currentQueue = githubQueue;
      const signature = (value) => JSON.stringify([value.parent.body, value.parent.state?.name, value.children.map((child) => [child.number, child.state.name, child.body])]);
      let lastAttemptSignature = signature(githubQueue);
      const baseDelayMs = Math.max(10_000, Number(process.env.CROSBY_GITHUB_POLL_MS ?? 30_000));
      let delayMs = baseDelayMs;
      let timer = null;
      const stop = () => { stopped = true; if (timer) clearTimeout(timer); resolve(); };
      const poll = async () => {
        try {
          const refreshed = await githubClient.loadParentQueue(currentQueue.parent.identifier);
          if (stopped) return;
          delayMs = baseDelayMs;
          currentQueue = refreshed;
          githubQueue = refreshed;
          dashboardController?.queueRefreshed(refreshed);
          if (refreshed.parent.state?.name === 'Done') { stop(); return; }
          const next = signature(refreshed);
          if (next === lastAttemptSignature) return;
          lastAttemptSignature = next;
          const result = await runDurableBuild(await writeGitHubBuild(refreshed, buildRoot), true);
          if (result?.readyForReview) stop();
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/rate limit|api rate limit|secondary rate limit/i.test(message)) delayMs = Math.min(Math.max(baseDelayMs * 10, 300_000), delayMs * 2);
          else { dashboardController?.fatal(error); notify(`Crosby monitor error: ${oneLine(message, 125)}`, 'error'); delayMs = baseDelayMs; }
        }
      };
      const schedule = () => { if (!stopped) timer = setTimeout(async () => { await poll(); schedule(); }, delayMs); };
      controller.signal.addEventListener('abort', stop, { once: true });
      monitorStop = stop;
      notify(`Crosby ${githubQueue.parent.identifier} · monitoring GitHub for resumable changes (every ${Math.round(baseDelayMs / 1000)}s).`);
      schedule();
    });
    let result;
    try {
      result = await runDurableBuild(command.buildFolder, command.mode === 'resume');
    } catch (error) {
      if (!controller.signal.aborted && githubClient && githubQueue && !watchMode) {
        say(`Crosby · not ready: ${oneLine(error.message ?? error, 125)} — inspect dashboard; resume after assistance`, 'error');
        await startQueueMonitor();
        return;
      }
      throw error;
    }
    if (githubClient && githubQueue && !watchMode && !result?.readyForReview) await startQueueMonitor();
    if (watchMode) {
      const signature = (queue) => JSON.stringify([queue.parent.body, queue.parent.state?.name, queue.children.map((child) => [child.number, child.state.name, child.body])]);
      let observed = signature(await githubClient.loadParentQueue(githubQueue.parent.identifier));
      while (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 60000));
        if (controller.signal.aborted) break;
        if (!result?.readyForReview) {
          const refreshed = await githubClient.loadParentQueue(githubQueue.parent.identifier);
          const changed = signature(refreshed);
          if (changed === observed) continue;
          observed = changed;
          githubQueue = refreshed;
          dashboardController?.queueRefreshed(refreshed);
          result = await runDurableBuild(await writeGitHubBuild(refreshed, buildRoot), true);
          continue;
        }
        const queues = await githubClient.loadExecuteParentQueues();
        const nextQueue = queues.find((queue) => !queue.children.some((child) => child.state.name === 'Building'));
        if (!nextQueue) continue;
        githubQueue = nextQueue;
        dashboardController = createDashboardController(nextQueue, 'watch');
        await openDashboardPane(dashboardController, sourcePath);
        parentClaimed = false;
        observed = signature(nextQueue);
        result = await runDurableBuild(await writeGitHubBuild(nextQueue, buildRoot));
      }
    }
    if (result) {
      await record('crosby-build-settled', { readyForReview: result.readyForReview, blockers: result.blockers, buildId: result.build.buildId, parentBranch: result.build.parentBranch, completedTaskIds: result.completed.map((entry) => entry.task.id), completedAt: new Date().toISOString() });
      if (!githubClient) notify(`Crosby ${result.build.buildId} · ${result.readyForReview ? 'ready for human review' : `not ready: ${result.blockers[0]?.summary ?? 'checks incomplete'}`}`, result.readyForReview ? 'success' : 'warning');
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    let message = error instanceof Error ? error.message : String(error);
    if (command && command.mode !== 'status' && statusArgs) {
      try {
        const status = await readBuildStatus(statusArgs);
        message = `${message}\n\n${formatBuildProgress(status.progress)}`;
      } catch { /* preserve the original error */ }
    }
    await record('crosby-error', { message });
    dashboardController?.fatal(message);
    notify(`Crosby · not ready: ${oneLine(message, 125)} — inspect dashboard; resume after assistance`, 'error');
    process.exitCode = 1;
  } finally {
    monitorStop?.();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [first, ...rest] = argv;
  try {
    if (first === 'done') return await runDone(rest);
    if (first === 'reviewer') return await runReviewer(rest, createHerdrForCli());
    const args = argv.join(' ');
    if (!parseGitHubCommand(args)) parseBuildCommandArgs(args);
    const herdrContext = requireCrosbyHerdrContext();
    const slot = await claimSupervisorSlot(herdrContext.pane, args);
    const controller = new AbortController();
    const shutdown = () => { controller.abort(); slot.release().finally(() => process.exit(130)); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, shutdown);
    try { await runCrosby(args, { controller, slot }); } finally { await slot.release(); }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), 'error');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
