import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishParentPullRequest } from "./lib-v2.mjs";
import { createHerdrClient } from "./herdr-client.mjs";
import { createHerdrCliInvoker } from "./herdr-cli.mjs";
import { requireCrosbyHerdrContext } from "./herdr-context.mjs";
import { persistWorkerReport } from "./worker-report.mjs";
import { formatBuildProgress, parseBuildCommandArgs, readBuildStatus, runBuild } from "./build-runner.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";
import { integrateTask } from "./integration.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { writeGitHubBuild, renderGitHubBuild } from "./github-build.mjs";
import { parseBuildTaskList } from './task-list.mjs';
import { buildGitHubChildProgress, buildGitHubParentSummary } from "./github-reporting.mjs";
import { parseGitHubCommand, runGitHubWatch } from "./github-actions.mjs";
import { ensureDashboardPane } from "./dashboard-launch.mjs";
import { registerGateWorker } from "./gate-worker.ts";
import { createGateStage, assertStableRevision, ensureGateAgentsSettled } from "./gate-stage.mjs";
import { runTaskGates } from "./gate-runner.mjs";
import { createParentVerifier } from "./parent-gates.mjs";
import { acknowledgeManualAction } from "./manual-recovery.mjs";
import { createProgressNotifier, oneLine } from "./progress-notifier.mjs";
import { createParentRepairPreparation } from "./parent-repair.mjs";
import { buildContractHash } from "./quality-gates.mjs";
import { verifiedPublicationTarget } from './publication-gate.mjs';
import { normalizeRepositoryUrl } from './github-source.mjs';

let activeDashboardController: any = null;
let activeGitHubClient: any = null;
let activeGitHubQueue: any = null;
let activeBuildContext: any = null;
let activeGitHubMonitorStop: (() => Promise<void>) | null = null;
let activeGitHubResume: (() => Promise<unknown>) | null = null;
const activeRunControllers = new Set<AbortController>();
import {
  createCrosbyDashboard,
  markDashboardExecutionStarted,
  markDashboardExecutionFinished,
  markDashboardExecutionFinalized,
  markDashboardHerdrWorkerStarted,
  markDashboardPaneOpened,
  markDashboardQualityStage,
  markDashboardFatalError,
  reconcileDashboardFromQueue,
  renderCrosbyCompactDashboard,
  renderCrosbyDashboard,
  persistDashboardEvent,
} from "./dashboard.mjs";
import { buildModelCandidates, selectTaskModel } from "./model-selector.mjs";

function getGhInvocation(args: string[]) {
  const configured = process.env.GH_BIN?.trim();
  return { command: configured || "gh", args };
}

function getGitInvocation(args: string[]) {
  const configured = process.env.GIT_BIN?.trim();
  return { command: configured || "git", args };
}

async function getPullRequestForBranch(
  pi: ExtensionAPI,
  branchName: string | undefined,
  cwd: string,
  options?: { allowMissing?: boolean },
) {
  const invocation = getGhInvocation([
    "pr",
    "view",
    ...(branchName ? [branchName] : []),
    "--json",
    "number,url,body,headRefName",
  ]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    if (options?.allowMissing && /no pull requests found for branch/i.test(details)) {
      return null;
    }
    throw new Error(
      details
        ? `Failed to load pull request details for branch ${branchName ?? "current"}. ${details}`
        : `Failed to load pull request details for branch ${branchName ?? "current"}. GitHub command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse pull request details for branch ${branchName ?? "current"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function createPullRequest(pi: ExtensionAPI, title: string, body: string, branchName: string | undefined, cwd: string) {
  const invocation = getGhInvocation([
    "pr",
    "create",
    ...(branchName ? ["--head", branchName] : []),
    "--title",
    title,
    "--body",
    body,
  ]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to create pull request for branch ${branchName ?? "current"}. ${details}`
        : `Failed to create pull request for branch ${branchName ?? "current"}. GitHub command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  const pullRequest = await getPullRequestForBranch(pi, branchName, cwd, { allowMissing: false });
  if (!pullRequest) {
    throw new Error(`Pull request creation reported success but no PR was found for branch ${branchName ?? "current"}.`);
  }

  return pullRequest;
}

async function updatePullRequestBody(pi: ExtensionAPI, prNumber: number, body: string, cwd: string) {
  const invocation = getGhInvocation(["pr", "edit", String(prNumber), "--body", body]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to update PR #${prNumber} description. ${details}`
        : `Failed to update PR #${prNumber} description. GitHub command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }
}

async function execGit(pi: ExtensionAPI, args: string[], cwd: string) {
  const invocation = getGitInvocation(args);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Git command failed in ${cwd}. ${details}`
        : `Git command failed in ${cwd}. Command: ${invocation.command} ${invocation.args.join(" ")}. Exit code: ${result.code}.`,
    );
  }

  return result;
}

async function resolveRepositoryIdentity(pi: ExtensionAPI, cwd: string) {
  const invocation = getGitInvocation(["-C", cwd, "remote", "get-url", "origin"]);
  const remote = await pi.exec(invocation.command, invocation.args, { cwd });
  return remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : path.resolve(cwd);
}

const workerCompletionReportSchema = Type.Object({
  outcome: Type.Literal("complete"),
  taskOutcome: Type.String(),
  summary: Type.String(),
  changes: Type.Object({ paths: Type.Array(Type.String()), commit: Type.String() }),
  verification: Type.Array(Type.Object({ command: Type.String(), result: Type.Union([Type.Literal("passed"), Type.Literal("skipped")]) })),
  risks: Type.Array(Type.String()),
});
const workerBlockedReportSchema = Type.Object({
  outcome: Type.Literal("blocked"),
  summary: Type.String(),
  requiredHumanAction: Type.String(),
  recoveryNotes: Type.Array(Type.String()),
  requestHerdrBlocked: Type.Literal(true),
});
const workerStoppedReportSchema = Type.Object({
  outcome: Type.Union([Type.Literal("failed"), Type.Literal("cancelled")]),
  summary: Type.String(),
  recoveryNotes: Type.Array(Type.String()),
});

function formatWorkerSessionSummary(taskKey: string, report: any) {
  const lines = [`Crosby session summary — ${taskKey}`, `Outcome: ${report.outcome}`];
  if (report.taskOutcome) lines.push(`Task result: ${report.taskOutcome}`);
  if (report.summary) lines.push(`Summary: ${report.summary}`);
  if (report.changes?.paths?.length) lines.push(`Changed files: ${report.changes.paths.join(", ")}`);
  if (report.changes?.commit) lines.push(`Commit: ${report.changes.commit}`);
  if (report.verification?.length) {
    lines.push("Verification:");
    for (const check of report.verification) lines.push(`- ${check.command}: ${check.result}`);
  }
  if (report.risks?.length) lines.push(`Risks/notes: ${report.risks.join("; ")}`);
  if (report.requiredHumanAction) lines.push(`Human action required: ${report.requiredHumanAction}`);
  if (report.recoveryNotes?.length) lines.push(`Recovery/testing notes: ${report.recoveryNotes.join("; ")}`);
  lines.push(report.outcome === "complete"
    ? "Test guidance: run the verification commands listed above and exercise the acceptance criteria for this task."
    : "Next step: follow the human action and recovery/testing notes above before marking this task complete.");
  return lines.join("\n");
}

function registerWorkerReportTool(pi: ExtensionAPI) {
  const workerEnvironmentReady = ["CROSBY_REGISTRY_ROOT", "CROSBY_REPOSITORY_ID", "CROSBY_PARENT_KEY", "CROSBY_TASK_KEY"].every((name) => process.env[name]?.trim());
  if (!workerEnvironmentReady) return;

  pi.on('tool_call', async (event: any) => {
    if (event.toolName === 'read') return;
    const store = createRegistryStore({ root: process.env.CROSBY_REGISTRY_ROOT, repositoryIdentity: process.env.CROSBY_REPOSITORY_ID, parentKey: process.env.CROSBY_PARENT_KEY, buildId: process.env.CROSBY_BUILD_ID || 'default', buildFolder: process.env.CROSBY_BUILD_FOLDER, parentBranch: process.env.CROSBY_PARENT_BRANCH, spaceId: process.env.CROSBY_SPACE_ID || process.env.HERDR_WORKSPACE_ID || 'default' });
    const worker = (await readRegistry(store)).workers?.[process.env.CROSBY_TASK_KEY!];
    if (worker?.report) return { block: true, reason: 'Builder report submitted. Remain idle until Crosby assigns a repair or resume.', terminate: true };
  });

  pi.registerTool({
    name: "crosby_worker_report",
    label: "Crosby Worker Report",
    description: "Submit the final validated completion or human-block report for this Crosby task. This is the worker's final action.",
    promptSnippet: "Submit the final Crosby worker report",
    promptGuidelines: ["Use crosby_worker_report as the final action for a Crosby task; report a human block instead of guessing or continuing unsafely."],
    parameters: Type.Union([workerCompletionReportSchema, workerBlockedReportSchema, workerStoppedReportSchema]),
    async execute(_toolCallId, params) {
      const emit = (pi as any).events?.emit;
      if (params.outcome === "blocked" && typeof emit !== "function") {
        throw new Error("Crosby cannot report a blocked worker because the Pi/Herdr event bridge is unavailable. Recovery: ask the operator for help from the visible worker tab.");
      }
      const saved = await persistWorkerReport({
        report: params,
        emitHerdrBlocked: typeof emit === "function" ? (payload: any) => emit.call((pi as any).events, "herdr:blocked", payload) : undefined,
      });
      const taskKey = saved.registry?.taskKey ?? process.env.CROSBY_TASK_KEY;
      return {
        content: [{ type: "text", text: `${formatWorkerSessionSummary(taskKey, params)}\n\nCrosby worker report recorded for ${taskKey}.` }],
        details: { outcome: params.outcome, reportedAt: saved.reportedAt, sessionSummary: formatWorkerSessionSummary(taskKey, params) },
        terminate: true,
      };
    },
  });
}

function compactCrosbyStatus(dashboard: any) {
  const active = dashboard?.tasks?.find((task: any) => ['in_progress', 'finishing'].includes(task.status));
  const review = dashboard?.tasks?.find((task: any) => task.status === "review");
  if (dashboard?.parentVerification?.stage === 'blocked') return oneLine(`Crosby ${dashboard.parentIssueKey}: not ready — ${dashboard.parentVerification.summary}`);
  if (active) return oneLine(`Crosby: ${active.issueKey ?? active.taskId} — ${dashboard.lastEvent?.message ?? 'working'}`);
  if (review) return `Crosby: ${review.issueKey ?? review.taskId} awaiting review`;
  if (dashboard?.fatalError) return "Crosby: execution error — inspect dashboard";
  if (dashboard?.completedAt) return "Crosby: parent execution complete";
  return "Crosby: monitoring";
}

function createDashboardController(ctx: any, queue: any, mode: string) {
  let dashboard = createCrosbyDashboard(queue, { mode });
  const render = () => {
    try {
      ctx.ui.setWidget("crosby-dashboard", [compactCrosbyStatus(dashboard)], { placement: "aboveEditor" });
    } catch {
      // Dashboard rendering is best effort.
    }
    persistDashboardEvent(dashboard);
  };
  render();
  return {
    get dashboard() { return dashboard; },
    paneOpened(event: any) { markDashboardPaneOpened(dashboard, event); render(); },
    qualityStage(event: any) { markDashboardQualityStage(dashboard, event); render(); },
    executionStarted(event: any) { markDashboardExecutionStarted(dashboard, event); render(); },
    workerStarted(event: any) { markDashboardHerdrWorkerStarted(dashboard, event); render(); },
    executionFinished(event: any) { markDashboardExecutionFinished(dashboard, event); render(); },
    executionFinalized(event: any) { markDashboardExecutionFinalized(dashboard, event); render(); },
    queueRefreshed(nextQueue: any) { reconcileDashboardFromQueue(dashboard, nextQueue); render(); },
    fatal(error: unknown) { markDashboardFatalError(dashboard, error); render(); },
  };
}

function startGitHubQueueMonitor({ client, queue, dashboardController, buildFolder, buildRoot, runBuild }: any) {
  if (activeGitHubMonitorStop) activeGitHubMonitorStop();
  let stopped = false;
  let running = false;
  let currentQueue = queue;
  const queueSignature = (value: any) => JSON.stringify([value.parent.body, value.parent.state?.name, value.children.map((child: any) => [child.number, child.state.name, child.body])]);
  let lastAttemptSignature = queueSignature(queue);
  const baseDelayMs = Math.max(10_000, Number(process.env.CROSBY_GITHUB_POLL_MS ?? 30_000));
  let delayMs = baseDelayMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  const poll = async () => {
    if (stopped || running) return;
    try {
      const refreshed = await client.loadParentQueue(currentQueue.parent.identifier);
      if (stopped) return;
      delayMs = baseDelayMs;
      currentQueue = refreshed;
      activeGitHubQueue = refreshed;
      dashboardController?.queueRefreshed(refreshed);
      if (refreshed.parent.state?.name === 'Done') { stop(); return; }
      const signature = queueSignature(refreshed);
      if (signature === lastAttemptSignature) return;
      lastAttemptSignature = signature;
      running = true;
      const folder = await writeGitHubBuild(refreshed, buildRoot);
      if (stopped) return;
      const result = await runBuild(folder, true);
      if (result?.readyForReview) stop();
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/rate limit|api rate limit|secondary rate limit/i.test(message)) {
        delayMs = Math.min(Math.max(baseDelayMs * 10, 300_000), delayMs * 2);
      } else {
        dashboardController?.fatal(error);
        delayMs = baseDelayMs;
      }
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(async () => {
      inFlight = poll();
      try { await inFlight; } finally { inFlight = null; schedule(); }
    }, delayMs);
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (activeGitHubMonitorStop === stop) activeGitHubMonitorStop = null;
    return inFlight ?? Promise.resolve();
  };
  schedule();
  activeGitHubMonitorStop = stop;
  return stop;
}

async function openDashboardPane(pi: ExtensionAPI, controller: any, sourcePath: string, herdrContext: any) {
  if (!controller || controller.dashboard.dashboardPaneId || process.env.CROSBY_DASHBOARD_PANE === "0") return;
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  try {
    const { paneId } = await ensureDashboardPane({
      exec: (command: string, args: string[]) => pi.exec(command, args),
      paneId: process.env.HERDR_PANE_ID,
      sourcePath,
      nodePath: process.execPath,
      runnerPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-runner.mjs"),
      runId: controller.dashboard.runId,
    });
    controller.paneOpened({ paneId });
  } catch (error) {
    controller.fatal(error);
  }
}

function registerReviewCompletionTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "crosby_review_complete",
    label: "Complete Crosby Review",
    description: "Acknowledge completed manual assistance and resume Crosby through required gates. Never closes a parent or bypasses code/browser verification.",
    promptSnippet: "Complete the active Crosby human review",
    promptGuidelines: ["Use this tool when the operator says the active Crosby review is done, complete, reviewed, approved, or otherwise finished."],
    parameters: Type.Object({ issue: Type.Optional(Type.String({ description: 'Child issue number when multiple tasks await assistance' })) }),
    async execute(_toolCallId, params) {
      if (!activeGitHubClient || !activeGitHubQueue || !activeDashboardController) throw new Error("No active GitHub Crosby review is available in the initiating Pi session.");
      const refreshed = await activeGitHubClient.loadParentQueue(activeGitHubQueue.parent.identifier);
      activeGitHubQueue = refreshed;
      activeDashboardController.queueRefreshed(refreshed);
      const candidates = refreshed.children.filter((child: any) => child.state.name === 'Review');
      const selected = params.issue ? candidates.find((child: any) => String(child.number) === params.issue!.replace(/^#/, '')) : candidates.length === 1 ? candidates[0] : null;
      if (!selected) throw new Error('Specify the child issue requiring assistance; do not guess among multiple waiting tasks. Use /crosby resume #parent for parent integration blockers.');
      if (!activeBuildContext) throw new Error('Resume the parent to restore its durable registry first.');
      const taskId = `task-${String(selected.number).padStart(3, '0')}`;
      const { manualOnly, task } = await acknowledgeManualAction({ store: createRegistryStore(activeBuildContext), taskId });
      if (manualOnly && !isStandaloneParentTask(task, refreshed)) await activeGitHubClient.moveIssue(selected.number, 'Done');
      else await activeGitHubClient.moveIssue(selected.number, 'Ready to Build');
      await activeGitHubClient.addComment(selected.number, 'Operator acknowledged manual assistance. Code-bearing work will resume through all required verification gates; the parent remains open.');
      if (activeGitHubResume) await activeGitHubResume();
      return { content: [{ type: 'text', text: `Crosby #${selected.number}: assistance recorded; resumed without bypassing required gates.` }] };
    },
  });
}

function parseGitHubIssueInvocation(args: string) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const value = tokens[0];
  if (/^#?\d+$/.test(value) || /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/i.test(value)) return value;
  return null;
}

function issueNumberForTask(task: any) {
  if (task?.sourceIssue) return String(task.sourceIssue).match(/\d+/)?.[0] ?? String(task.sourceIssue);
  return String(task?.id ?? "").replace(/^task-0*/, "");
}

function isStandaloneParentTask(task: any, queue: any) {
  if (task?.standaloneParentTask === true) return true;
  const issueNumber = issueNumberForTask(task);
  return queue?.standaloneParentTask === true
    && queue?.children?.some((child: any) => child?.standaloneParentTask === true && String(child?.number) === issueNumber);
}

function queueWithStandaloneTaskState(queue: any, stateName: string) {
  if (!queue?.standaloneParentTask) return queue;
  const state = stateName === "Done" ? { name: "Done", type: "completed" } : { name: stateName, type: "started" };
  const children = (queue.children ?? []).map((child: any) => child?.standaloneParentTask ? { ...child, state } : child);
  return { ...queue, parent: { ...queue.parent, children }, children };
}

export default function crosbyExtension(pi: ExtensionAPI) {
  if (registerGateWorker(pi)) return;
  let commandRunning = false;
  let durableBuildRunning = false;
  let sessionClosed = false;
  pi.on('session_shutdown', async () => {
    sessionClosed = true;
    activeGitHubMonitorStop?.();
    for (const controller of activeRunControllers) controller.abort();
    activeRunControllers.clear();
    activeGitHubResume = null;
  });
  registerWorkerReportTool(pi);
  registerReviewCompletionTool(pi);
  const runCommand = async (args: string, ctx: ExtensionCommandContext) => {
      let command: ReturnType<typeof parseBuildCommandArgs> | undefined;
      let statusArgs: any;
      let githubClient: any;
      let githubQueue: any;
      let dashboardController: any;
      let watchMode = false;
      const controller = new AbortController();
      activeRunControllers.add(controller);
      const notify = createProgressNotifier((line: string, level: any) => { ctx.ui.setStatus('crosby', line); ctx.ui.notify(line, level === 'success' ? 'info' : level); });
      try {
        const previousMonitor = activeGitHubMonitorStop?.();
        for (const previous of activeRunControllers) {
          if (previous !== controller) { previous.abort(); activeRunControllers.delete(previous); }
        }
        activeGitHubResume = null;
        await previousMonitor;
        controller.signal.throwIfAborted();
        const githubCommand = parseGitHubCommand(args);
        watchMode = githubCommand?.mode === "watch";
        let githubIssue = ['parent', 'resume', 'review'].includes(githubCommand?.mode ?? '') ? githubCommand!.issueRef : parseGitHubIssueInvocation(args);
        const sourcePath = process.cwd();
        const identity = await resolveRepositoryIdentity(pi, sourcePath);
        controller.signal.throwIfAborted();
        if (watchMode) {
          githubClient = createGitHubClient({ repository: identity, exec: (name: string, ghArgs: string[]) => pi.exec(name, ghArgs, { cwd: sourcePath }) });
          const queues = await githubClient.loadExecuteParentQueues();
          githubQueue = queues.find((queue: any) => !queue.children.some((child: any) => child.state.name === "Building"));
          if (!githubQueue) {
            ctx.ui.notify("Crosby watch cycle is idle; no runnable GitHub parent was found.", "info");
            return;
          }
          githubIssue = githubQueue.parent.identifier;
        }
        if (githubCommand?.mode === "push") {
          githubClient = createGitHubClient({ repository: identity, exec: (name: string, ghArgs: string[]) => pi.exec(name, ghArgs, { cwd: sourcePath }) });
          githubQueue = await githubClient.loadParentQueue(githubCommand.issueRef);
          const folder = await writeGitHubBuild(githubQueue, path.join(homedir(), '.pi', 'crosby', 'github-builds'));
          const state = await readBuildStatus({ buildFolder: folder, sourcePath, workspace: requireCrosbyHerdrContext().workspace, registryRoot: path.join(homedir(), '.pi', 'crosby'), repositoryIdentity: identity });
          const gateExec = (name: string, args: string[], options: any) => pi.exec(name, args, options);
          const target = await verifiedPublicationTarget({ state, branch: githubQueue.parent.branchName, exec: gateExec });
          const repository = normalizeRepositoryUrl(identity).replace(/^https:\/\/github\.com\//, '');
          if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw new Error('Cannot resolve an explicit GitHub repository for publication.');
          const publishingPi = Object.create(pi);
          publishingPi.exec = (name: string, args: string[], options: any) => pi.exec(name, name === getGhInvocation([]).command ? [...args, '--repo', repository] : args, options);
          const operations: any = {
            routing: { cwd: target.cwd },
            ensureParentBranch: async () => { await verifiedPublicationTarget({ state, branch: target.branch, exec: gateExec }); },
            assertCleanWorkingTree: async () => { await verifiedPublicationTarget({ state, branch: target.branch, exec: gateExec }); },
            readImplementationSummary: async () => `${buildGitHubParentSummary({ parent: githubQueue.parent, children: githubQueue.children })}\n\nVerified revision: ${target.revision}. Required code/browser and combined-parent checks passed. Parent remains open for human review.`,
            pushBranch: async () => {
              await verifiedPublicationTarget({ state, branch: target.branch, exec: gateExec });
              await execGit(pi, ['push', identity, `${target.revision}:refs/heads/${target.branch}`], target.cwd);
            },
            getPullRequest: ({ branchName, cwd, allowMissing }: any) => getPullRequestForBranch(publishingPi, branchName, cwd, { allowMissing }),
            createPullRequest: ({ title, body, branchName, cwd }: any) => createPullRequest(publishingPi, title, body, branchName, cwd),
            updatePullRequest: ({ prNumber, body, cwd }: any) => updatePullRequestBody(publishingPi, prNumber, body, cwd),
            addParentComment: (key: string, body: string) => githubClient.addComment(key, body),
          };
          const result = await publishParentPullRequest(githubQueue.standaloneParentTask ? queueWithStandaloneTaskState(githubQueue, 'Done') : githubQueue, [], operations);
          ctx.ui.notify(`Crosby ${githubCommand.mode} completed for ${githubQueue.parent.identifier}: ${result?.url ?? result?.pullRequest?.url ?? "done"}.`, "success");
          return;
        }
        if (githubIssue) {
          githubClient = createGitHubClient({ repository: identity, exec: (name: string, ghArgs: string[]) => pi.exec(name, ghArgs, { cwd: sourcePath }) });
          githubQueue = await githubClient.loadParentQueue(githubIssue);
          activeGitHubClient = githubClient;
          activeGitHubQueue = githubQueue;
          const buildFolder = await writeGitHubBuild(githubQueue, path.join(homedir(), ".pi", "crosby", "github-builds"));
          command = parseBuildCommandArgs(`${['resume', 'review'].includes(githubCommand?.mode ?? '') ? 'resume' : 'run'} ${buildFolder}`);
        } else {
          command = parseBuildCommandArgs(args);
        }
        const herdrContext = requireCrosbyHerdrContext();
        if (githubQueue) {
          dashboardController = createDashboardController(ctx, githubQueue, "manual");
          activeDashboardController = dashboardController;
          await openDashboardPane(pi, dashboardController, sourcePath, herdrContext);
          const firstActiveChild = githubQueue.children.find((child: any) => !["Done", "Review"].includes(child.state?.name));
          if (firstActiveChild) dashboardController.executionStarted({ child: firstActiveChild, parent: githubQueue.parent });
        }
        const invokeHerdrCli = createHerdrCliInvoker({ exec: (commandName: string, commandArgs: string[]) => pi.exec(commandName, commandArgs) });
        const herdr = createHerdrClient({ invoke: invokeHerdrCli });
        const registryRoot = path.join(homedir(), ".pi", "crosby");
        statusArgs = { buildFolder: command.buildFolder, sourcePath, workspace: herdrContext.workspace, registryRoot, repositoryIdentity: identity };
        if (command.mode === "status") {
          const status = await readBuildStatus(statusArgs);
          pi.appendEntry("crosby-build-progress", status.progress);
          return;
        }
        if (!ctx.model) throw new Error("Crosby requires an active parent Pi model to assess worker model selection.");
        const modelCandidates = buildModelCandidates({
          currentModel: ctx.model,
          availableModels: ctx.modelRegistry.getAvailable(),
        });
        const assessTaskModel = async (prompt: string) => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok) throw new Error(`Could not authenticate the Crosby model-selection orchestrator: ${auth.error}`);
          const message: UserMessage = {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          };
          const response = await complete(
            ctx.model!,
            {
              systemPrompt: "You route isolated coding tasks to an allowed model. Follow the requested output format exactly.",
              messages: [message],
            },
            { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 2048 },
          );
          const text = response.content
            .filter((content: any) => content.type === "text")
            .map((content: any) => content.text)
            .join("")
            .trim();
          if (!text) {
            const contentTypes = response.content.map((content: any) => content.type).join(", ") || "none";
            throw new Error(`Crosby model-selection assessment returned no text (stop reason: ${response.stopReason}; content: ${contentTypes}; error: ${response.errorMessage ?? "none"}).`);
          }
          return text;
        };
        const waitForReport = async ({ task, store }: any) => {
          const deadline = Date.now() + 60 * 60_000;
          while (Date.now() < deadline) {
            if (controller.signal.aborted) throw new Error('Crosby interrupted; retained work can be resumed explicitly.');
            const registry = await readRegistry(store);
            const worker = registry.workers?.[task.id];
            if (worker?.report && ["complete", "blocked", "failed", "cancelled"].includes(worker.report.outcome)) return worker.report;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          throw new Error(`Builder #${issueNumberForTask(task)} did not submit a report within one hour. Inspect retained pane and resume explicitly.`);
        };
        activeBuildContext = { root: registryRoot, registryRoot, repositoryIdentity: identity, parentKey: githubQueue?.parent?.branchName ?? command.buildFolder, buildId: githubQueue?.parent?.number ? `github-${githubQueue.parent.number}` : null, buildFolder: command.buildFolder, parentBranch: githubQueue?.parent?.branchName ?? null, spaceId: herdrContext.workspace };
        let parentClaimed = false;
        const selectRoleModel = async ({ task, role }: any) => {
          const roleEnv = role === 'test' ? 'TESTER' : role === 'review' ? 'REVIEWER' : 'BUILDER';
          const configured = process.env[`CROSBY_${roleEnv}_MODEL`];
          const configuredThinking = process.env[`CROSBY_${roleEnv}_THINKING`];
          const routed = role ? { ...task, modelHint: configured || null, thinkingHint: configuredThinking || null } : task;
          const selection = await selectTaskModel({ task: routed, candidates: modelCandidates, assess: assessTaskModel });
          pi.appendEntry('crosby-worker-model-selected', { taskId: task.id, role: role || 'builder', ...selection });
          return selection;
        };
        const gateStage = createGateStage({ herdr, exec: (name: string, args: string[], options: any) => pi.exec(name, args, options), root: registryRoot, selectModel: selectRoleModel, signal: controller.signal, onProgress: async (event: any) => {
          pi.appendEntry('crosby-gate-progress', event);
          dashboardController?.qualityStage(event);
          notify(`Crosby ${githubQueue?.parent?.identifier ?? ''} · ${event.taskId} ${event.summary}`);
        } });
        const buildAdapters = {
          herdrClient: herdr,
          selectTaskModel: selectRoleModel,
          verifyTask: (input: any) => runTaskGates({ ...input, stage: gateStage }),
          verifyParent: createParentVerifier({ herdr, stage: gateStage, exec: (name: string, args: string[], options: any) => pi.exec(name, args, options) }),
          prepareParentRepair: createParentRepairPreparation((name: string, args: string[], options: any) => pi.exec(name, args, options)),
          beforeTaskResume: ({ task, store }: any) => ensureGateAgentsSettled({ herdr, store, taskId: task.id }),
          waitForReport,
          integrateTask: (input: any) => integrateTask(input),
          onTaskStarting: async ({ task, registry }: any) => {
            if (controller.signal.aborted) throw new Error('Crosby interrupted before worker launch.');
            activeBuildContext = createRegistryStore({ root: registryRoot, repositoryIdentity: identity, parentKey: registry.parentKey, buildId: registry.buildId, buildFolder: registry.buildFolder, parentBranch: registry.parentBranch, spaceId: registry.spaceId });
            if (githubClient) {
              if (!parentClaimed && githubQueue?.parent) {
                await githubClient.moveIssue(githubQueue.parent.identifier, "Building");
                parentClaimed = true;
              }
              const issueNumber = issueNumberForTask(task);
              if (!isStandaloneParentTask(task, githubQueue)) {
                const latest = await githubClient.loadIssue(issueNumber, { includeChildren: false });
                if (latest.state.name === 'Done') await githubClient.reopenIssue(issueNumber);
                await githubClient.moveIssue(issueNumber, 'Building');
              }
              const active = activeDashboardController?.dashboard?.tasks?.find((entry: any) => entry.issueKey === `#${issueNumber}` || entry.taskId === task.id);
              if (active) activeDashboardController.executionStarted({ child: { identifier: `#${issueNumber}`, title: task.title }, parent: activeGitHubQueue?.parent });
            }
          },
          onTaskIntegrated: async ({ task, report }: any) => {
            const issueNumber = issueNumberForTask(task);
            dashboardController?.executionFinished({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'done', summary: report.summary } });
            dashboardController?.executionFinalized({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'done', summary: report.summary } });
            if (githubClient) {
              if (!isStandaloneParentTask(task, githubQueue)) await githubClient.moveIssue(issueNumber, "Done");
              await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: report.outcome, summary: report.summary, changes: report.changes?.paths ?? [report.changes?.commit ?? "recorded in the durable worktree"], verification: report.verification?.map((entry: any) => `${entry.command}: ${entry.result}`), recoveryNotes: report.risks }));
            }
          },
          onTaskReview: async ({ task, report, registry }: any) => {
            activeBuildContext = createRegistryStore({ root: registryRoot, repositoryIdentity: identity, parentKey: registry.parentKey, buildId: registry.buildId, buildFolder: registry.buildFolder, parentBranch: registry.parentBranch, spaceId: registry.spaceId });
            const issueNumber = issueNumberForTask(task);
            dashboardController?.executionFinalized({ child: { identifier: `#${issueNumber}`, title: task.title }, workerResult: { outcome: 'review', summary: report.summary, requiredHumanAction: report.requiredHumanAction, recoveryNotes: report.recoveryNotes } });
            dashboardController?.qualityStage({ taskId: task.id, stage: 'blocked', summary: report.summary, requiredHumanAction: report.requiredHumanAction, artifactDir: report.artifactDir ?? report.reports?.[0]?.reportPath });
            if (githubClient) {
              await githubClient.moveIssue(issueNumber, "Review");
              await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: "review", summary: report.summary, recoveryNotes: [report.requiredHumanAction, ...(report.recoveryNotes ?? [])] }));
            }
          },
          onProgress: async (progress: any) => {
            pi.appendEntry("crosby-build-progress", progress);
            notify(formatBuildProgress(progress));
          },
          emitLifecycle: (event: any) => {
            if (event.lifecycle === "working") {
              const issueNumber = String(event.taskId ?? "").replace(/^task-0*/, "");
              dashboardController?.workerStarted({ ...event, taskId: issueNumber ? `#${issueNumber}` : event.taskId });
            }
            pi.appendEntry("crosby-worker-lifecycle", event);
          },
        };
        const runDurableBuild = async (buildFolder: string, resume = false) => {
          controller.signal.throwIfAborted();
          if (durableBuildRunning) return null;
          durableBuildRunning = true;
          dashboardController?.qualityStage({ taskId: null, stage: 'running', summary: 'Evaluating current contracts and gates; not ready until verification completes.' });
          try {
            const result = await runBuild({ buildFolder, sourcePath, workspace: herdrContext.workspace, pane: herdrContext.pane, agent: process.env.HERDR_AGENT_NAME || "crosby-supervisor", registryRoot, repositoryIdentity: identity, resume, adapters: buildAdapters });
            controller.signal.throwIfAborted();
            activeBuildContext = result.registry;
            if (result.readyForReview && githubClient && githubQueue) {
              const latest = await githubClient.loadParentQueue(githubQueue.parent.identifier);
              const approved = (await readRegistry(result.registry)).parentVerification;
              if (buildContractHash(parseBuildTaskList(renderGitHubBuild(latest))) !== approved?.buildContractHash) {
                result.readyForReview = false;
                result.blockers.push({ taskId: null, outcome: 'blocked', summary: 'Issue contracts changed during execution; previous approval is stale.', requiredHumanAction: `Confirm updated scope and run /crosby resume ${latest.parent.identifier}.` });
                await updateRegistry(result.registry, (registry) => ({ ...registry, readyForReview: false, blockers: result.blockers }));
              }
            }
            dashboardController?.qualityStage({ taskId: null, stage: result.readyForReview ? 'ready' : 'blocked', summary: result.readyForReview ? `All gates passed. Review worktree: ${result.parent.path}; parent remains open.` : result.blockers.map((item: any) => `${item.taskId ?? 'parent'}: ${item.summary}`).join('; '), requiredHumanAction: result.readyForReview ? 'Review the complete experience and manually close the parent.' : result.blockers.map((item: any) => item.requiredHumanAction).filter(Boolean).join('; ') });
            if (githubClient && githubQueue) {
              const summary = result.readyForReview
                ? `Ready for human review. All child and combined-parent gates passed. Review worktree: ${result.parent.path}. Follow repository review/startup instructions. Parent stays open for the operator to close.`
                : `Not ready for review.\n${result.blockers.map((item: any) => `${item.taskId ?? 'parent'}: ${item.summary}\nAssistance: ${item.requiredHumanAction ?? 'Inspect retained evidence.'}`).join('\n')}\nResume: /crosby resume ${githubQueue.parent.identifier}`;
              await githubClient.addComment(githubQueue.parent.identifier, summary);
              await githubClient.moveIssue(githubQueue.parent.identifier, result.readyForReview ? 'Review' : 'Building');
              notify(`Crosby ${githubQueue.parent.identifier} · ${result.readyForReview ? 'ready for your review — parent remains open' : `not ready: ${result.blockers[0]?.summary ?? 'verification incomplete'} — see dashboard/action report`}`, result.readyForReview ? 'success' : 'warning');
            }
            return result;
          } finally {
            durableBuildRunning = false;
          }
        };
        let result: any;
        if (githubClient && githubQueue) {
          activeGitHubResume = async () => {
            const refreshed = await githubClient.loadParentQueue(githubQueue.parent.identifier);
            controller.signal.throwIfAborted();
            githubQueue = refreshed;
            activeGitHubQueue = refreshed;
            dashboardController?.queueRefreshed(refreshed);
            const folder = await writeGitHubBuild(refreshed, path.join(homedir(), '.pi', 'crosby', 'github-builds'));
            result = await runDurableBuild(folder, true);
            return result;
          };
        }
        try {
          result = await runDurableBuild(command.buildFolder, command.mode === 'resume');
        } catch (error) {
          if (!controller.signal.aborted && githubClient && githubQueue && !watchMode) {
            startGitHubQueueMonitor({ client: githubClient, queue: githubQueue, dashboardController, buildFolder: command.buildFolder, buildRoot: path.join(homedir(), ".pi", "crosby", "github-builds"), runBuild: runDurableBuild });
          }
          throw error;
        }
        if (githubClient && githubQueue && !watchMode && !result?.readyForReview) {
          startGitHubQueueMonitor({ client: githubClient, queue: githubQueue, dashboardController, buildFolder: command.buildFolder, buildRoot: path.join(homedir(), ".pi", "crosby", "github-builds"), runBuild: runDurableBuild });
        }
        if (watchMode) {
          const signature = (queue: any) => JSON.stringify([queue.parent.body, queue.parent.state?.name, queue.children.map((child: any) => [child.number, child.state.name, child.body])]);
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
              activeGitHubQueue = refreshed;
              dashboardController?.queueRefreshed(refreshed);
              result = await runDurableBuild(await writeGitHubBuild(refreshed, path.join(homedir(), '.pi', 'crosby', 'github-builds')), true);
              continue;
            }
            const queues = await githubClient.loadExecuteParentQueues();
            const nextQueue = queues.find((queue: any) => !queue.children.some((child: any) => child.state.name === "Building"));
            if (!nextQueue) continue;
            githubQueue = nextQueue;
            activeGitHubQueue = nextQueue;
            dashboardController = createDashboardController(ctx, nextQueue, 'watch');
            activeDashboardController = dashboardController;
            await openDashboardPane(pi, dashboardController, sourcePath, herdrContext);
            parentClaimed = false;
            observed = signature(nextQueue);
            const nextFolder = await writeGitHubBuild(nextQueue, path.join(homedir(), ".pi", "crosby", "github-builds"));
            result = await runDurableBuild(nextFolder);
          }
        }
        pi.appendEntry('crosby-build-settled', {
          readyForReview: result.readyForReview,
          blockers: result.blockers,
          buildId: result.build.buildId,
          parentBranch: result.build.parentBranch,
          completedTaskIds: result.completed.map((entry: any) => entry.task.id),
          completedAt: new Date().toISOString(),
        });
        if (!githubClient) notify(`Crosby ${result.build.buildId} · ${result.readyForReview ? 'ready for human review' : `not ready: ${result.blockers[0]?.summary ?? 'checks incomplete'}`}`, result.readyForReview ? 'success' : 'warning');
      } catch (error) {
        if (controller.signal.aborted || sessionClosed) return;
        let message = error instanceof Error ? error.message : String(error);
        if (command && command.mode !== "status" && statusArgs) {
          try {
            const status = await readBuildStatus(statusArgs);
            pi.appendEntry("crosby-build-progress", status.progress);
            message = `${message}\n\n${formatBuildProgress(status.progress)}`;
          } catch {
            // Preserve the original build error when progress recovery also fails.
          }
        }
        pi.appendEntry('crosby-error', { message });
        dashboardController?.fatal(message);
        notify(`Crosby · not ready: ${oneLine(message, 125)} — inspect dashboard; resume after assistance`, 'error');
      } finally {
        if (!activeGitHubMonitorStop) activeRunControllers.delete(controller);
      }
  };
  pi.registerCommand("crosby", {
    description: "Build, review and browser-test GitHub children; resume #parent after assistance; parent stays open for human review.",
    handler: async (args, ctx) => {
      if (sessionClosed) return;
      if (commandRunning || durableBuildRunning) {
        ctx.ui.notify('Crosby supervision is already running in this session. Normal conversation remains available; see the dashboard for progress.', 'warning');
        return;
      }
      // Pi awaits slash-command handlers before accepting the next ordinary turn.
      // Supervision must outlive this handler, not hold the trigger editor hostage.
      commandRunning = true;
      void runCommand(args, ctx).catch((error: unknown) => {
        if (sessionClosed) return;
        ctx.ui.notify(`Crosby supervisor failed: ${oneLine(String(error), 125)}`, 'error');
      }).finally(() => { commandRunning = false; });
    },
  });
}
