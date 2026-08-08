import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRalphLoopPrompt,
  fetchParentQueue,
  parseCrosbyCommandArgs,
  publishParentPullRequest,
  reviewParentPullRequest,
  resolveIssueWorkingDirectory,
  selectNextRunnableChild,
} from "./lib-v2.mjs";
import { createHerdrClient } from "./herdr-client.mjs";
import { createHerdrCliInvoker } from "./herdr-cli.mjs";
import { requireCrosbyHerdrContext } from "./herdr-context.mjs";
import { persistWorkerReport } from "./worker-report.mjs";
import { formatBuildProgress, parseBuildCommandArgs, readBuildStatus, runBuild } from "./build-runner.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";
import { integrateTask } from "./integration.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { writeGitHubBuild } from "./github-build.mjs";
import { buildGitHubChildProgress, buildGitHubParentSummary } from "./github-reporting.mjs";
import { parseGitHubCommand, runGitHubWatch } from "./github-actions.mjs";
import { buildDashboardPaneCommand, dashboardPaneSplitArguments } from "./dashboard-launch.mjs";

let activeDashboardController: any = null;
let activeGitHubClient: any = null;
let activeGitHubQueue: any = null;
let activeBuildContext: any = null;
import {
  createCrosbyDashboard,
  markDashboardExecutionStarted,
  markDashboardExecutionFinished,
  markDashboardExecutionFinalized,
  markDashboardHerdrWorkerStarted,
  markDashboardPaneOpened,
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

// Intentionally do not force a Pi worker model here.
// Let isolated workers inherit normal Pi model resolution from the parent environment/session config.
const DEFAULT_CROSBY_CLAUDE_MODEL = process.env.CROSBY_CLAUDE_MODEL?.trim() || "claude-sonnet-4-6";
const DEFAULT_CROSBY_CLAUDE_EFFORT = process.env.CROSBY_CLAUDE_EFFORT?.trim() || "medium";

function getClaudeInvocation(args: string[]) {
  const configured = process.env.CLAUDE_BIN?.trim();
  return { command: configured || "claude", args };
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

async function addPullRequestComment(pi: ExtensionAPI, prNumber: number, body: string, cwd: string) {
  const invocation = getGhInvocation(["pr", "comment", String(prNumber), "--body", body]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to add PR comment to #${prNumber}. ${details}`
        : `Failed to add PR comment to #${prNumber}. GitHub command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }
}

async function readImplementationSummary(cwd: string) {
  const summaryPath = path.join(cwd, "implementation_summary.md");
  try {
    return await readFile(summaryPath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read implementation_summary.md from ${summaryPath}. ${error instanceof Error ? error.message : String(error)}`,
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

async function isGitRepository(pi: ExtensionAPI, cwd: string) {
  const invocation = getGitInvocation(["rev-parse", "--is-inside-work-tree"]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });
  return result.code === 0 && result.stdout.trim() === "true";
}

async function resolveRepositoryIdentity(pi: ExtensionAPI, cwd: string) {
  const invocation = getGitInvocation(["-C", cwd, "remote", "get-url", "origin"]);
  const remote = await pi.exec(invocation.command, invocation.args, { cwd });
  return remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : path.resolve(cwd);
}

async function getCurrentGitBranch(pi: ExtensionAPI, cwd: string) {
  const result = await execGit(pi, ["branch", "--show-current"], cwd);
  return result.stdout.trim();
}

async function hasLocalGitBranch(pi: ExtensionAPI, cwd: string, branchName: string) {
  const result = await execGit(pi, ["branch", "--list", branchName], cwd);
  return result.stdout.trim().length > 0;
}

async function hasRemoteGitBranch(pi: ExtensionAPI, cwd: string, branchName: string) {
  const result = await execGit(pi, ["branch", "-r", "--list", `origin/${branchName}`], cwd);
  return result.stdout.trim().length > 0;
}

async function hasUncommittedGitChanges(pi: ExtensionAPI, cwd: string) {
  const result = await execGit(pi, ["status", "--short"], cwd);
  return result.stdout.trim().length > 0;
}

async function assertCleanWorkingTree(pi: ExtensionAPI, cwd: string, command: "push" | "review") {
  if (!(await hasUncommittedGitChanges(pi, cwd))) return;

  throw new Error(
    `Cannot run /crosby ${command} in ${cwd} because the working tree has uncommitted changes. Recovery: commit, stash, or discard the local changes first, then rerun /crosby ${command}.`,
  );
}

async function pushGitBranch(pi: ExtensionAPI, cwd: string, branchName?: string) {
  const resolvedBranchName = String(branchName ?? "").trim();
  if (!resolvedBranchName) {
    throw new Error("Cannot push the parent branch because the issue did not provide a branch name. Recovery: set Branch metadata on the GitHub parent issue, then rerun /crosby push.");
  }

  await execGit(pi, ["push", "-u", "origin", resolvedBranchName], cwd);
}

async function ensureParentBranch(pi: ExtensionAPI, parentIssue: any, cwd?: string) {
  const issueKey = parentIssue?.identifier ?? "UNKNOWN-PARENT";
  const branchName = String(parentIssue?.branchName ?? "").trim();

  if (!cwd) {
    throw new Error(
      `Cannot ensure the feature branch for ${issueKey} because no local project directory was resolved. Recovery: add a folder label matching the local repo, then rerun /crosby ${issueKey}.`,
    );
  }

  if (!branchName) {
    throw new Error(
      `Parent issue ${issueKey} is missing a branch name. Recovery: set Branch metadata on the GitHub parent issue, then rerun /crosby ${issueKey}.`,
    );
  }

  if (!(await isGitRepository(pi, cwd))) {
    throw new Error(
      `Resolved project directory ${cwd} for parent ${issueKey} is not a git repository. Recovery: point the issue label at the correct local repo folder, or initialize/clone the repo there, then rerun /crosby ${issueKey}.`,
    );
  }

  const currentBranch = await getCurrentGitBranch(pi, cwd);
  if (currentBranch === branchName) return;

  if (await hasUncommittedGitChanges(pi, cwd)) {
    throw new Error(
      `Cannot switch ${cwd} from branch ${currentBranch || "(detached HEAD)"} to ${branchName} for parent ${issueKey} because the working tree has uncommitted changes. Recovery: commit, stash, or discard the local changes in ${cwd}, then rerun /crosby ${issueKey}.`,
    );
  }

  if (await hasLocalGitBranch(pi, cwd, branchName)) {
    await execGit(pi, ["checkout", branchName], cwd);
  } else if (await hasRemoteGitBranch(pi, cwd, branchName)) {
    await execGit(pi, ["checkout", "-b", branchName, "--track", `origin/${branchName}`], cwd);
  } else {
    await execGit(pi, ["checkout", "-b", branchName], cwd);
  }

  const verifiedBranch = await getCurrentGitBranch(pi, cwd);
  if (verifiedBranch !== branchName) {
    throw new Error(
      `Expected repo in ${cwd} to be on branch ${branchName} for ${issueKey}, but found ${verifiedBranch || "(detached HEAD)"}. Recovery: switch to ${branchName} manually, then rerun /crosby ${issueKey}.`,
    );
  }
}

async function runClaudeReviewWorker(pi: ExtensionAPI, prompt: string, cwd: string) {
  const schema = JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: ["clean", "fixed", "error"] },
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      tests: { type: "array", items: { type: "string" } },
      remainingConcerns: { type: "array", items: { type: "string" } },
      commits: { type: "array", items: { type: "string" } },
    },
    required: ["outcome", "summary", "changes", "tests", "remainingConcerns", "commits"],
  });
  const invocation = getClaudeInvocation([
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    DEFAULT_CROSBY_CLAUDE_MODEL,
    "--effort",
    DEFAULT_CROSBY_CLAUDE_EFFORT,
    "--json-schema",
    schema,
    prompt,
  ]);
  const result = await pi.exec(invocation.command, invocation.args, { cwd });

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Claude review worker failed. ${details}`
        : `Claude review worker failed. Claude command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  return result;
}

function formatIssuePath(path: any[] | undefined) {
  return (Array.isArray(path) ? path : [])
    .map((issue) => issue?.identifier)
    .filter(Boolean)
    .join(" > ");
}

function appendWorkerTranscript(pi: ExtensionAPI, event: any) {
  const pathText = formatIssuePath(event.path);
  pi.appendEntry("crosby-worker-transcript", {
    parentIssueKey: event.parent?.identifier ?? null,
    topLevelIssueKey: event.topLevelChild?.identifier ?? null,
    issueKey: event.child?.identifier ?? null,
    issuePath: pathText,
    outcome: event.workerResult?.outcome ?? null,
    recoveryNotes: event.workerResult?.recoveryNotes ?? [],
    cwd: event.cwd ?? null,
    stdout: event.rawWorkerResult?.stdout ?? "",
    stderr: event.rawWorkerResult?.stderr ?? "",
  });
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

function registerWorkerReportTool(pi: ExtensionAPI) {
  const workerEnvironmentReady = ["CROSBY_REGISTRY_ROOT", "CROSBY_REPOSITORY_ID", "CROSBY_PARENT_KEY", "CROSBY_TASK_KEY"].every((name) => process.env[name]?.trim());
  if (!workerEnvironmentReady) return;

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
      return {
        content: [{ type: "text", text: `Crosby worker report recorded for ${saved.registry?.taskKey ?? process.env.CROSBY_TASK_KEY}.` }],
        details: { outcome: params.outcome, reportedAt: saved.reportedAt },
        terminate: true,
      };
    },
  });
}

function compactCrosbyStatus(dashboard: any) {
  const active = dashboard?.tasks?.find((task: any) => ["in-progress", "started"].includes(task.status));
  const review = dashboard?.tasks?.find((task: any) => task.status === "review");
  if (active) return `Crosby: ${active.issueKey ?? active.taskId} active — monitoring`;
  if (review) return `Crosby: ${review.issueKey ?? review.taskId} awaiting review`;
  if (dashboard?.fatalError) return "Crosby: execution error — inspect dashboard";
  if (dashboard?.completedAt) return "Crosby: parent execution complete";
  return "Crosby: monitoring";
}

function createDashboardController(ctx: any, queue: any, mode: string) {
  let dashboard = createCrosbyDashboard(queue, { mode });
  const render = () => {
    try {
      ctx.ui.setWidget("crosby-dashboard", compactCrosbyStatus(dashboard), { placement: "aboveEditor" });
    } catch {
      // Dashboard rendering is best effort.
    }
    persistDashboardEvent(dashboard);
  };
  render();
  return {
    get dashboard() { return dashboard; },
    paneOpened(event: any) { markDashboardPaneOpened(dashboard, event); render(); },
    executionStarted(event: any) { markDashboardExecutionStarted(dashboard, event); render(); },
    workerStarted(event: any) { markDashboardHerdrWorkerStarted(dashboard, event); render(); },
    executionFinished(event: any) { markDashboardExecutionFinished(dashboard, event); render(); },
    executionFinalized(event: any) { markDashboardExecutionFinalized(dashboard, event); render(); },
    queueRefreshed(nextQueue: any) { reconcileDashboardFromQueue(dashboard, nextQueue); render(); },
    fatal(error: unknown) { markDashboardFatalError(dashboard, error); render(); },
  };
}

async function openDashboardPane(pi: ExtensionAPI, controller: any, sourcePath: string, herdrContext: any) {
  if (!controller || controller.dashboard.dashboardPaneId || process.env.CROSBY_DASHBOARD_PANE === "0") return;
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return;
  try {
    const split = await pi.exec("herdr", dashboardPaneSplitArguments({ paneId: process.env.HERDR_PANE_ID, sourcePath }));
    if (split.code !== 0) throw new Error(split.stderr || "dashboard pane split failed");
    const payload = JSON.parse(split.stdout);
    const paneId = payload?.result?.pane?.pane_id ?? payload?.result?.root_pane?.pane_id ?? payload?.result?.pane_id;
    if (!paneId) throw new Error("Herdr did not return the dashboard pane id.");
    const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-runner.mjs");
    const command = buildDashboardPaneCommand({ nodePath: process.execPath, runnerPath: runner, runId: controller.dashboard.runId });
    const launch = await pi.exec("herdr", ["pane", "run", paneId, command]);
    if (launch.code !== 0) throw new Error(launch.stderr || "dashboard pane launch failed");
    controller.paneOpened({ paneId });
  } catch (error) {
    controller.fatal(error);
  }
}

function registerReviewCompletionTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "crosby_review_complete",
    label: "Complete Crosby Review",
    description: "Mark the active human-reviewed Crosby task complete after the operator says it is done, complete, reviewed, or approved.",
    promptSnippet: "Complete the active Crosby human review",
    promptGuidelines: ["Use this tool when the operator says the active Crosby review is done, complete, reviewed, approved, or otherwise finished."],
    parameters: Type.Object({}),
    async execute() {
      if (!activeGitHubClient || !activeGitHubQueue || !activeDashboardController) throw new Error("No active GitHub Crosby review is available.");
      const reviewTask = activeDashboardController.dashboard.tasks.find((task: any) => task.status === "review");
      if (!reviewTask?.issueKey) throw new Error("No Crosby task is currently awaiting human review.");
      const taskId = `task-${String(reviewTask.issueKey).replace(/\D/g, "").padStart(3, "0")}`;
      if (activeBuildContext) {
        const store = createRegistryStore(activeBuildContext);
        const registry = await readRegistry(store);
        const worker = registry.workers?.[taskId];
        const task = registry.tasks?.[taskId];
        if (worker?.taskWorktree && registry.parentWorktree && task) {
          const integration = await integrateTask({ task, taskWorktree: worker.taskWorktree, parentWorktree: registry.parentWorktree, report: worker.report });
          await updateRegistry(store, (current) => ({ ...current, workers: { ...current.workers, [taskId]: { ...current.workers[taskId], lifecycle: "integrated", report: { ...current.workers[taskId].report, outcome: "complete", taskOutcome: "Human review completed", changes: { paths: integration.changedPaths, commit: integration.commit }, verification: integration.verification, risks: [] } } } }));
        }
      }
      await activeGitHubClient.moveIssue(reviewTask.issueKey, "Done");
      await activeGitHubClient.addComment(reviewTask.issueKey, "Human review completed; task approved and marked complete by the operator.");
      const refreshed = await activeGitHubClient.loadParentQueue(activeGitHubQueue.parent.identifier);
      activeGitHubQueue = refreshed;
      activeDashboardController.queueRefreshed(refreshed);
      activeDashboardController.executionFinalized({ child: { identifier: reviewTask.issueKey }, workerResult: { outcome: "done", summary: "Human review completed." } });
      return { content: [{ type: "text", text: `Crosby review completed for ${reviewTask.issueKey}; GitHub and the dashboard were updated.` }] };
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

export default function crosbyExtension(pi: ExtensionAPI) {
  pi.registerEntryRenderer("crosby-build-progress", (entry: any, _options: any, theme: any) => (
    new Text(theme.fg("accent", formatBuildProgress(entry.data)), 0, 0)
  ));
  registerWorkerReportTool(pi);
  registerReviewCompletionTool(pi);
  pi.registerCommand("crosby", {
    description: "Run or resume a sequential Herdr-visible Crosby build from a local build folder",
    handler: async (args, ctx) => {
      let command: ReturnType<typeof parseBuildCommandArgs> | undefined;
      let statusArgs: any;
      let githubClient: any;
      let githubQueue: any;
      let dashboardController: any;
      let watchMode = false;
      try {
        const githubCommand = parseGitHubCommand(args);
        watchMode = githubCommand?.mode === "watch";
        let githubIssue = githubCommand?.mode === "parent" ? githubCommand.issueRef : parseGitHubIssueInvocation(args);
        const sourcePath = process.cwd();
        const identity = await resolveRepositoryIdentity(pi, sourcePath);
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
        if (githubCommand?.mode === "push" || githubCommand?.mode === "review") {
          githubClient = createGitHubClient({ repository: identity, exec: (name: string, ghArgs: string[]) => pi.exec(name, ghArgs, { cwd: sourcePath }) });
          githubQueue = await githubClient.loadParentQueue(githubCommand.issueRef);
          const operations: any = {
            routing: { cwd: sourcePath },
            ensureParentBranch: ({ parent, cwd }: any) => ensureParentBranch(pi, parent, cwd),
            assertCleanWorkingTree: ({ cwd, command: action }: any) => assertCleanWorkingTree(pi, cwd, action),
            readImplementationSummary: ({ cwd }: any) => readImplementationSummary(cwd),
            pushBranch: ({ branchName, cwd }: any) => pushGitBranch(pi, cwd, branchName),
            getPullRequest: ({ branchName, cwd, allowMissing }: any) => getPullRequestForBranch(pi, branchName, cwd, { allowMissing }),
            createPullRequest: ({ title, body, branchName, cwd }: any) => createPullRequest(pi, title, body, branchName, cwd),
            updatePullRequest: ({ prNumber, body, cwd }: any) => updatePullRequestBody(pi, prNumber, body, cwd),
            addParentComment: (key: string, body: string) => addIssueComment(pi, key, body),
            addPullRequestComment: ({ prNumber, body, cwd }: any) => addPullRequestComment(pi, prNumber, body, cwd),
            runClaudeReview: ({ prompt, cwd }: any) => runClaudeReviewWorker(pi, prompt, cwd),
          };
          const result = githubCommand.mode === "push"
            ? await publishParentPullRequest(githubQueue, [], operations)
            : await reviewParentPullRequest(githubQueue, [], operations);
          ctx.ui.notify(`Crosby ${githubCommand.mode} completed for ${githubQueue.parent.identifier}: ${result?.url ?? result?.pullRequest?.url ?? "done"}.`, "success");
          return;
        }
        if (githubIssue) {
          githubClient = createGitHubClient({ repository: identity, exec: (name: string, ghArgs: string[]) => pi.exec(name, ghArgs, { cwd: sourcePath }) });
          githubQueue = await githubClient.loadParentQueue(githubIssue);
          activeGitHubClient = githubClient;
          activeGitHubQueue = githubQueue;
          const buildFolder = await writeGitHubBuild(githubQueue, path.join(homedir(), ".pi", "crosby", "github-builds"));
          command = parseBuildCommandArgs(`run ${buildFolder}`);
        } else {
          command = parseBuildCommandArgs(args);
        }
        const herdrContext = requireCrosbyHerdrContext();
        if (githubQueue) {
          dashboardController = createDashboardController(ctx, githubQueue, "manual");
          activeDashboardController = dashboardController;
          await openDashboardPane(pi, dashboardController, sourcePath, herdrContext);
          if (githubQueue.children[0]) dashboardController.executionStarted({ child: githubQueue.children[0], parent: githubQueue.parent });
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
          while (true) {
            const registry = await readRegistry(store);
            const worker = registry.workers?.[task.id];
            if (worker?.report && ["complete", "blocked", "failed", "cancelled"].includes(worker.report.outcome)) return worker.report;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        };
        activeBuildContext = { root: registryRoot, registryRoot, repositoryIdentity: identity, parentKey: githubQueue?.parent?.branchName ?? command.buildFolder, buildId: githubQueue?.parent?.number ? `github-${githubQueue.parent.number}` : null, buildFolder: command.buildFolder, parentBranch: githubQueue?.parent?.branchName ?? null, spaceId: herdrContext.workspace };
        const buildAdapters = {
          herdrClient: herdr,
          selectTaskModel: async ({ task }: any) => {
            const selection = await selectTaskModel({ task, candidates: modelCandidates, assess: assessTaskModel });
            pi.appendEntry("crosby-worker-model-selected", { taskId: task.id, ...selection });
            ctx.ui.notify(`Crosby ${task.id}: ${selection.model} with ${selection.thinking} thinking.`, "info");
            return selection;
          },
          waitForReport,
          integrateTask: (input: any) => integrateTask(input),
          onTaskStarting: async ({ task }: any) => {
            if (githubClient) {
              const issueNumber = task.id.replace(/^task-0*/, "");
              await githubClient.moveIssue(issueNumber, "Building");
              const active = activeDashboardController?.dashboard?.tasks?.find((entry: any) => entry.issueKey === `#${issueNumber}`);
              if (active) activeDashboardController.executionStarted({ child: { identifier: `#${issueNumber}`, title: task.title }, parent: activeGitHubQueue?.parent });
            }
          },
          onTaskIntegrated: async ({ task, report }: any) => {
            dashboardController?.executionFinished({ child: { identifier: task.id, title: task.title }, workerResult: { outcome: report.outcome ?? "complete" } });
            dashboardController?.executionFinalized({ child: { identifier: task.id, title: task.title }, workerResult: { outcome: report.outcome ?? "complete" } });
            if (githubClient) {
              const issueNumber = task.id.replace(/^task-0*/, "");
              await githubClient.moveIssue(issueNumber, "Done");
              await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: report.outcome, summary: report.summary, changes: report.changes?.paths ?? [report.changes?.commit ?? "recorded in the durable worktree"], verification: report.verification?.map((entry: any) => `${entry.command}: ${entry.result}`), recoveryNotes: report.risks }));
            }
          },
          onTaskReview: async ({ task, report }: any) => {
            dashboardController?.executionFinished({ child: { identifier: task.id, title: task.title }, workerResult: { outcome: "review", requiredHumanAction: report.requiredHumanAction, recoveryNotes: report.recoveryNotes } });
            if (githubClient) {
              const issueNumber = task.id.replace(/^task-0*/, "");
              await githubClient.moveIssue(issueNumber, "Review");
              await githubClient.addComment(issueNumber, buildGitHubChildProgress({ child: { identifier: `#${issueNumber}` }, outcome: "review", summary: report.summary, recoveryNotes: [report.requiredHumanAction, ...(report.recoveryNotes ?? [])] }));
            }
          },
          onProgress: async (progress: any) => {
            pi.appendEntry("crosby-build-progress", progress);
            ctx.ui.notify(formatBuildProgress(progress), "info");
          },
          emitLifecycle: (event: any) => {
            if (event.lifecycle === "working") dashboardController?.workerStarted(event);
            pi.appendEntry("crosby-worker-lifecycle", event);
          },
        };
        const runDurableBuild = (buildFolder: string) => runBuild({ buildFolder, sourcePath, workspace: herdrContext.workspace, pane: herdrContext.pane, agent: process.env.HERDR_AGENT_NAME || "crosby-supervisor", registryRoot, repositoryIdentity: identity, adapters: buildAdapters });
        let result = await runDurableBuild(command.buildFolder);
        if (watchMode) {
          while (true) {
            await new Promise((resolve) => setTimeout(resolve, 60000));
            const queues = await githubClient.loadExecuteParentQueues();
            const nextQueue = queues.find((queue: any) => !queue.children.some((child: any) => child.state.name === "Building"));
            if (!nextQueue) continue;
            githubQueue = nextQueue;
            const nextFolder = await writeGitHubBuild(nextQueue, path.join(homedir(), ".pi", "crosby", "github-builds"));
            result = await runDurableBuild(nextFolder);
          }
        }
        if (githubClient && githubQueue) {
          const refreshed = await githubClient.loadParentQueue(githubQueue.parent.identifier);
          if (refreshed.children.every((child: any) => child.state.name === "Done")) {
            await githubClient.addComment(refreshed.parent.identifier, buildGitHubParentSummary({ parent: refreshed.parent, children: refreshed.children.filter((child: any) => child.state.name === "Done") }));
            await githubClient.moveIssue(refreshed.parent.identifier, "Review");
          }
        }
        pi.appendEntry("crosby-build-complete", {
          buildId: result.build.buildId,
          parentBranch: result.build.parentBranch,
          completedTaskIds: result.completed.map((entry: any) => entry.task.id),
          completedAt: new Date().toISOString(),
        });
        ctx.ui.notify(`Crosby ${command.mode} completed ${result.completed.length} task(s). Parent branch is ready for review; no PR was created.`, "success");
      } catch (error) {
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
        ctx.ui.notify(message, "error");
      }
    },
  });
}
