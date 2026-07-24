import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildRalphLoopPrompt,
  fetchParentQueue,
  parseCrosbyCommandArgs,
  publishParentPullRequest,
  reviewParentPullRequest,
  resolveIssueWorkingDirectory,
} from "./lib-v2.mjs";
import { createHerdrClient } from "./herdr-client.mjs";
import { createHerdrCliInvoker } from "./herdr-cli.mjs";
import { requireCrosbyHerdrContext } from "./herdr-context.mjs";
import { persistWorkerReport } from "./worker-report.mjs";
import {
  createVisibleWorkerScheduler,
  integrateWorkerReport,
  runFinalIntegrationChecks,
  workerReportToExecutionResult,
  createCrosbySupervisor,
  selectGlobalWorkerCandidates,
} from "./scheduler.mjs";
import { buildChildIntegrationComment, buildFinalIntegrationComment, buildParentIntegrationComment, buildSupervisorStatusReport } from "./linear-reporting.mjs";
import { parseProjectConfig } from "./project-config.mjs";

function getLinearInvocation(args: string[]) {
  const configured = process.env.LINEAR_BIN?.trim();
  if (configured) {
    return { command: configured, args };
  }

  const appData = process.env.APPDATA;
  if (process.platform === "win32" && appData) {
    const runnerScript = path.join(appData, "npm", "node_modules", "@kyaukyuai", "linear-cli", "run-linear.js");
    if (existsSync(runnerScript)) {
      return { command: process.execPath, args: [runnerScript, ...args] };
    }
  }

  return { command: "linear", args };
}

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

async function loadIssueLabelsFromLinear(pi: ExtensionAPI, issueKey: string) {
  const invocation = getLinearInvocation([
    "api",
    'query($id:String!){ issue(id:$id){ labels { nodes { name } } } }',
    "--variable",
    `id=${issueKey}`,
  ]);
  const result = await pi.exec(invocation.command, invocation.args);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to load labels for ${issueKey} from Linear. ${details}`
        : `Failed to load labels for ${issueKey} from Linear. Linear command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  try {
    return JSON.parse(result.stdout)?.data?.issue?.labels ?? { nodes: [] };
  } catch (error) {
    throw new Error(
      `Failed to parse Linear label data for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadIssueFromLinear(pi: ExtensionAPI, issueKey: string) {
  const invocation = getLinearInvocation(["issue", "view", issueKey, "--json"]);
  const result = await pi.exec(invocation.command, invocation.args);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to load ${issueKey} from Linear. ${details}`
        : `Failed to load ${issueKey} from Linear. Linear command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  try {
    const issue = JSON.parse(result.stdout);
    const labelTargets = [issue, ...(Array.isArray(issue?.children) ? issue.children : [])].filter(
      (target) => target?.identifier && !target?.labels,
    );

    await Promise.all(
      labelTargets.map(async (target) => {
        target.labels = await loadIssueLabelsFromLinear(pi, target.identifier);
      }),
    );

    return issue;
  } catch (error) {
    throw new Error(
      `Failed to parse Linear queue data for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadIssuesByStateFromLinear(pi: ExtensionAPI, stateName: string) {
  const invocation = getLinearInvocation([
    "api",
    `query($stateName:String!){ issues(filter: { state: { name: { eq: $stateName } } }) { nodes { identifier title priority state { name type } parent { identifier title } labels { nodes { name } } } } }`,
    "--variable",
    `stateName=${stateName}`,
  ]);
  const result = await pi.exec(invocation.command, invocation.args);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to load ${stateName} issues from Linear. ${details}`
        : `Failed to load ${stateName} issues from Linear. Linear command: ${invocation.command}. Exit code: ${result.code}.`,
    );
  }

  try {
    const payload = JSON.parse(result.stdout);
    return payload?.data?.issues?.nodes ?? [];
  } catch (error) {
    throw new Error(
      `Failed to parse ${stateName} issue data from Linear: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadExecuteParentQueuesFromLinear(pi: ExtensionAPI) {
  const executeIssues = await loadIssuesByStateFromLinear(pi, "Execute");
  const executeParents = executeIssues.filter((issue) => issue?.identifier && !issue?.parent);
  return Promise.all(executeParents.map((issue) => fetchParentQueue(issue.identifier, (key) => loadIssueFromLinear(pi, key))));
}

function normalizeTargetState(state: string, issueKey?: string) {
  switch (state) {
    case "Building":
      return issueKey && /^COA-\d+$/i.test(issueKey) ? "Build" : "Building";
    case "Review":
      return "In Review";
    default:
      return state;
  }
}

async function moveIssue(pi: ExtensionAPI, issueKey: string, state: string) {
  const targetState = normalizeTargetState(state, issueKey);
  const invocation = getLinearInvocation(["issue", "move", issueKey, targetState]);
  const result = await pi.exec(invocation.command, invocation.args);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to move ${issueKey} to ${targetState}. ${details}`
        : `Failed to move ${issueKey} to ${targetState}. Check Linear CLI authentication and try again.`,
    );
  }
}

async function addIssueComment(pi: ExtensionAPI, issueKey: string, body: string) {
  const invocation = getLinearInvocation(["issue", "comment", "add", issueKey, body]);
  const result = await pi.exec(invocation.command, invocation.args);

  if (result.code !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      details
        ? `Failed to add comment to ${issueKey}. ${details}`
        : `Failed to add comment to ${issueKey}. Check Linear CLI authentication and try again.`,
    );
  }
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
    throw new Error("Cannot push the parent branch because Linear did not provide a branch name. Recovery: set the parent branch name in Linear, then rerun /crosby push.");
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
      `Parent issue ${issueKey} is missing a Linear branch name. Recovery: set the parent branch in Linear, then rerun /crosby ${issueKey}.`,
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

async function finalizeParentIntegration(pi: ExtensionAPI, queue: any, completedChildren: any[]) {
  const integration = [...completedChildren].reverse().map((entry) => entry?.workerResult?.integration).find(Boolean);
  const parentWorktreePath = integration?.parentWorktreePath;
  if (!parentWorktreePath) {
    throw new Error(`Cannot run final integration checks for ${queue.parent.identifier}: managed parent worktree is unavailable. Recovery: rerun the final child integration from its retained Crosby worktree.`);
  }
  const config = parseProjectConfig(await readFile(path.join(parentWorktreePath, ".pi", "crosby.json"), "utf8"));
  await runFinalIntegrationChecks({ parentWorktreePath, config });
  await addIssueComment(pi, queue.parent.identifier, buildFinalIntegrationComment({ parent: queue.parent, children: queue.children }));
  await moveIssue(pi, queue.parent.identifier, "Review");
}

async function reportIntegrationToLinear(pi: ExtensionAPI, event: any) {
  const integration = event?.workerResult?.integration;
  if (!integration) return;
  const child = event.child;
  const childBody = buildChildIntegrationComment({
    child,
    outcome: integration.outcome,
    summary: event.workerResult?.summary,
    changedPaths: integration.changedPaths,
    verification: integration.verification,
    merge: integration.merge,
    retained: integration.retained,
  });
  await addIssueComment(pi, child.identifier, childBody);
  await addIssueComment(
    pi,
    event.parent.identifier,
    buildParentIntegrationComment({
      child,
      outcome: integration.outcome,
      requiredHumanAction: event.workerResult?.requiredHumanAction,
    }),
  );
}

async function resolveRepositoryIdentity(pi: ExtensionAPI, cwd: string) {
  const remote = await pi.exec("git", ["-C", cwd, "remote", "get-url", "origin"]);
  return remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : path.resolve(cwd);
}

async function createVisibleRuntime(pi: ExtensionAPI) {
  const { workspace } = requireCrosbyHerdrContext();
  const invokeHerdrCli = createHerdrCliInvoker({ exec: (command: string, args: string[]) => pi.exec(command, args) });
  const herdr = createHerdrClient({ invoke: invokeHerdrCli });
  return {
    workspace,
    scheduler: createVisibleWorkerScheduler({ registryRoot: path.join(homedir(), ".pi", "crosby"), herdr }),
  };
}

async function queueContext(pi: ExtensionAPI, queue: any, source: "manual" | "watch") {
  const cwd = resolveIssueWorkingDirectory(queue.parent).cwd;
  return { ...queue, source, cwd, repositoryIdentity: await resolveRepositoryIdentity(pi, cwd) };
}

function integrationExecution(report: any, integration: any, child: any) {
  if (integration.outcome === "done" || report.outcome === "blocked") return workerReportToExecutionResult(report, child);
  return {
    issueKey: child.identifier,
    issueTitle: child.title,
    outcome: "review",
    summary: integration.summary,
    changes: [],
    tests: [],
    requiredHumanAction: "Inspect the retained task worktree and resolve the integration failure.",
    recoveryNotes: integration.retained?.recoveryNotes ?? [],
  };
}

async function reconcileVisibleQueue(pi: ExtensionAPI, runtime: any, context: any) {
  let workers = await runtime.scheduler.listWorkers({ repositoryIdentity: context.repositoryIdentity, parentKey: context.parent.identifier });
  for (const worker of workers) {
    if (!["launching", "running", "recovering"].includes(worker.lifecycle)) continue;
    const child = context.children.find((entry: any) => entry?.identifier === worker?.registry?.taskKey);
    if (!child) continue;
    await runtime.scheduler.reconcileWorker({
      parent: context.parent,
      child,
      prompt: buildRalphLoopPrompt(child),
      sourcePath: context.cwd,
      repositoryIdentity: context.repositoryIdentity,
      workspace: runtime.workspace,
    });
  }
  workers = await runtime.scheduler.listWorkers({ repositoryIdentity: context.repositoryIdentity, parentKey: context.parent.identifier });
  const settled = [];

  for (const worker of workers) {
    if (!["reported", "blocked", "integrated"].includes(worker.lifecycle)) continue;
    const taskKey = worker?.registry?.taskKey;
    const child = context.children.find((entry: any) => entry?.identifier === taskKey);
    if (!child) continue;
    const report = await runtime.scheduler.getWorkerReport(worker);
    if (!report) continue;

    const integration = worker.lifecycle === "integrated" && worker.integration
      ? worker.integration
      : await integrateWorkerReport({
          parent: { integrationWorktree: worker.parentWorktree?.path },
          child,
          worker,
          report,
        });
    const workerResult = integrationExecution(report, integration, child);
    if (worker.lifecycle !== "integrated") await runtime.scheduler.markWorkerIntegrated(worker, integration);
    await moveIssue(pi, child.identifier, workerResult.outcome === "done" ? "Done" : "In Review");
    const event = { parent: context.parent, child, workerResult };
    appendWorkerTranscript(pi, event);
    await reportIntegrationToLinear(pi, event);
    await runtime.scheduler.markWorkerFinalized(worker);
    settled.push({ child, workerResult });
  }

  const refreshed = await fetchParentQueue(context.parent.identifier, (key) => loadIssueFromLinear(pi, key));
  if (
    !/^in review$/i.test(String(refreshed.parent?.state?.name ?? "")) &&
    refreshed.children.length > 0 &&
    refreshed.children.every((child: any) => /^done$/i.test(String(child?.state?.name ?? "")))
  ) {
    const completed = workers
      .filter((worker: any) => worker.integration)
      .map((worker: any) => ({ workerResult: { integration: worker.integration } }));
    await finalizeParentIntegration(pi, refreshed, completed);
  }
  return settled;
}

async function launchVisibleCandidates(pi: ExtensionAPI, runtime: any, contexts: any[]) {
  const activeWorkers = (await runtime.scheduler.listAllWorkers())
    .filter((worker: any) => ["launching", "running", "recovering"].includes(worker.lifecycle))
    .map((worker: any) => ({ repositoryIdentity: worker.registry?.repositoryIdentity, contract: worker.contract ?? { parallel: "sequential" } }));
  const candidates = selectGlobalWorkerCandidates({ queues: contexts, activeWorkers, capacity: 2 });
  const launched = [];

  for (const candidate of candidates) {
    const context = candidate;
    const child = candidate.child;
    await moveIssue(pi, child.identifier, "Building");
    try {
      const result = await runtime.scheduler.launch({
        parent: context.parent,
        child,
        prompt: buildRalphLoopPrompt(child),
        sourcePath: context.cwd,
        repositoryIdentity: context.repositoryIdentity,
        workspace: runtime.workspace,
      });
      const event = { parent: context.parent, child, topLevelChild: child, path: [child], cwd: context.cwd };
      pi.appendEntry("crosby-worker-started", {
        parentIssueKey: context.parent.identifier,
        topLevelIssueKey: child.identifier,
        issueKey: child.identifier,
        issuePath: child.identifier,
        cwd: context.cwd,
      });
      launched.push({ child, result, event });
    } catch (error) {
      await moveIssue(pi, child.identifier, "Ready to Build");
      throw error;
    }
  }
  return launched;
}

async function runVisibleSchedulingCycle(pi: ExtensionAPI, runtime: any, queues: any[], source: "manual" | "watch") {
  const contexts = await Promise.all(queues.map((queue) => queueContext(pi, queue, source)));
  const settled = (await Promise.all(contexts.map((context) => reconcileVisibleQueue(pi, runtime, context)))).flat();
  const refreshedContexts = await Promise.all(contexts.map(async (context) => queueContext(pi, await fetchParentQueue(context.parent.identifier, (key) => loadIssueFromLinear(pi, key)), source)));
  const launched = await launchVisibleCandidates(pi, runtime, refreshedContexts);
  return { settled, launched };
}

const supervisorTaskSchema = Type.Object({
  parentKey: Type.String({ description: "Linear parent queue key, for example COA-360." }),
  taskKey: Type.String({ description: "Explicit Linear child task key, for example COA-367." }),
});
const supervisorAskSchema = Type.Object({
  parentKey: Type.String({ description: "Linear parent queue key, for example COA-360." }),
  taskKey: Type.String({ description: "Explicit Linear child task key, for example COA-367." }),
  message: Type.String({ description: "The operator message to send to the retained worker." }),
});

function supervisorToolResult(parentKey: string, status: any, prefix?: string) {
  const report = buildSupervisorStatusReport({ parentKey, status });
  return {
    content: [{ type: "text" as const, text: prefix ? `${prefix}\n\n${report}` : report }],
    details: status,
  };
}

async function createSupervisorForTask(pi: ExtensionAPI, parentKey: string, taskKey: string) {
  const queue = await fetchParentQueue(parentKey, (key) => loadIssueFromLinear(pi, key));
  if (!queue.children.some((child: any) => child?.identifier === taskKey)) {
    throw new Error(`Task ${taskKey} is not a child of ${queue.parent.identifier}. Recovery: provide the parent queue key that owns the task.`);
  }
  const cwd = resolveIssueWorkingDirectory(queue.parent).cwd;
  const repositoryIdentity = await resolveRepositoryIdentity(pi, cwd);
  requireCrosbyHerdrContext();
  const invokeHerdrCli = createHerdrCliInvoker({ exec: (command: string, args: string[]) => pi.exec(command, args) });
  const herdr = createHerdrClient({ invoke: invokeHerdrCli });
  return createCrosbySupervisor({
    registryRoot: path.join(homedir(), ".pi", "crosby"),
    repositoryIdentity,
    parentKey: queue.parent.identifier,
    herdr,
    cleanupTask: async ({ worker }: any) => {
      const taskPath = String(worker?.task?.path ?? "").trim();
      if (!taskPath) throw new Error("Recorded Crosby task has no managed worktree path to clean up.");
      const controlPath = String(worker?.parentWorktree?.path ?? cwd).trim();
      await execGit(pi, ["-C", controlPath, "worktree", "remove", "--force", taskPath], cwd);
    },
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

function registerWorkerReportTool(pi: ExtensionAPI) {
  const workerEnvironmentReady = ["CROSBY_REGISTRY_ROOT", "CROSBY_REPOSITORY_ID", "CROSBY_PARENT_KEY", "CROSBY_TASK_KEY"].every((name) => process.env[name]?.trim());
  if (!workerEnvironmentReady) return;

  pi.registerTool({
    name: "crosby_worker_report",
    label: "Crosby Worker Report",
    description: "Submit the final validated completion or human-block report for this Crosby task. This is the worker's final action.",
    promptSnippet: "Submit the final Crosby worker report",
    promptGuidelines: ["Use crosby_worker_report as the final action for a Crosby task; report a human block instead of guessing or continuing unsafely."],
    parameters: Type.Union([workerCompletionReportSchema, workerBlockedReportSchema]),
    async execute(_toolCallId, params) {
      const emit = (pi as any).events?.emit;
      if (params.outcome === "blocked" && typeof emit !== "function") {
        throw new Error("Crosby cannot report a blocked worker because the Pi/Herdr event bridge is unavailable. Recovery: ask the operator for help from the visible worker tab.");
      }
      const saved = await persistWorkerReport({
        report: params,
        emitHerdrBlocked: params.outcome === "blocked" ? (payload: any) => emit.call((pi as any).events, "herdr:blocked", payload) : undefined,
      });
      return {
        content: [{ type: "text", text: `Crosby worker report recorded for ${saved.registry?.taskKey ?? process.env.CROSBY_TASK_KEY}.` }],
        details: { outcome: params.outcome, reportedAt: saved.reportedAt },
        terminate: true,
      };
    },
  });
}

function registerSupervisorTools(pi: ExtensionAPI) {
  const taskTool = (
    name: string,
    label: string,
    description: string,
    promptSnippet: string,
    promptGuidelines: string[],
    operation: "status" | "pause" | "resume",
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      promptSnippet,
      promptGuidelines,
      parameters: supervisorTaskSchema,
      async execute(_toolCallId, params) {
        const supervisor = await createSupervisorForTask(pi, params.parentKey, params.taskKey);
        const status = await supervisor[operation]({ taskKey: params.taskKey });
        return supervisorToolResult(params.parentKey, status);
      },
    });
  };

  taskTool("crosby_task_status", "Crosby Task Status", "Show compact supervisor status for an explicit Crosby task key.", "Show Crosby task status.", ["Use crosby_task_status when an operator asks about a Crosby task or worker."], "status");
  taskTool("crosby_task_pause", "Pause Crosby Task", "Ask a running Crosby worker to pause and retain its task evidence.", "Pause a Crosby task.", ["Use crosby_task_pause when an operator asks to pause a specific Crosby worker."], "pause");
  taskTool("crosby_task_resume", "Resume Crosby Task", "Resume a previously paused Crosby worker.", "Resume a Crosby task.", ["Use crosby_task_resume when an operator asks to resume a specific paused Crosby worker."], "resume");

  pi.registerTool({
    name: "crosby_task_ask",
    label: "Ask Crosby Task",
    description: "Send an operator message to an explicit retained Crosby worker.",
    promptSnippet: "Ask a Crosby worker for an update.",
    promptGuidelines: ["Use crosby_task_ask when an operator conversationally asks a specific Crosby worker a question."],
    parameters: supervisorAskSchema,
    async execute(_toolCallId, params) {
      const supervisor = await createSupervisorForTask(pi, params.parentKey, params.taskKey);
      const status = await supervisor.ask({ taskKey: params.taskKey, message: params.message });
      return supervisorToolResult(params.parentKey, status, "Message sent.");
    },
  });

  for (const [name, label, action] of [["crosby_task_stop", "Stop Crosby Task", "stop"], ["crosby_task_cleanup", "Clean Up Crosby Task", "cleanup"]] as const) {
    pi.registerTool({
      name,
      label,
      description: `${action === "stop" ? "Stop a worker while retaining its task worktree." : "Remove a retained Crosby tab and managed task worktree."} Confirmation is required.`,
      promptSnippet: `${action === "stop" ? "Stop" : "Clean up"} a Crosby task.`,
      promptGuidelines: [`Use ${name} when an operator asks to ${action} a specific Crosby task; it always confirms the reported impact first.`],
      parameters: supervisorTaskSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const supervisor = await createSupervisorForTask(pi, params.parentKey, params.taskKey);
        const preview = await supervisor[action]({ taskKey: params.taskKey });
        const confirmation = await ctx.ui.confirm(
          `${action === "stop" ? "Stop" : "Clean up"} Crosby task ${params.taskKey}?`,
          `${buildSupervisorStatusReport({ parentKey: params.parentKey, status: preview.impact })}\n\n${action === "stop" ? "This closes the worker tab but retains its worktree and branch." : "This permanently removes the retained worker tab and managed task worktree."}`,
        );
        if (!confirmation) return supervisorToolResult(params.parentKey, preview.impact, "Cancelled; no destructive action was taken.");
        const status = await supervisor[action]({ taskKey: params.taskKey, confirmed: true });
        return supervisorToolResult(params.parentKey, status, `${action === "stop" ? "Stopped" : "Cleaned up"}.`);
      },
    });
  }
}

export default function crosbyExtension(pi: ExtensionAPI) {
  registerWorkerReportTool(pi);
  registerSupervisorTools(pi);
  pi.registerCommand("crosby", {
    description: "Execute parent child-work, watch Execute parents, or explicitly push/review a parent PR",
    handler: async (args, ctx) => {
      try {
        const command = parseCrosbyCommandArgs(args);

        if (command.mode === "watch") {
          const runtime = await createVisibleRuntime(pi);
          ctx.ui.notify("Crosby watch mode started. Reconciling and dispatching Herdr workers every 60s.", "success");
          while (true) {
            try {
              const queues = await loadExecuteParentQueuesFromLinear(pi);
              const cycle = await runVisibleSchedulingCycle(pi, runtime, queues, "watch");
              if (cycle.settled.length || cycle.launched.length) {
                ctx.ui.notify(`Crosby reconciled ${cycle.settled.length} and launched ${cycle.launched.length} worker(s).`, "success");
              }
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
            await new Promise((resolve) => setTimeout(resolve, 60000));
          }
        }

        const issueKey = command.issueKey;
        const queue = await fetchParentQueue(issueKey, (key) => loadIssueFromLinear(pi, key));

        if (command.mode === "push") {
          const pullRequest = await publishParentPullRequest(queue, [], {
            ensureParentBranch: ({ parent, cwd }) => ensureParentBranch(pi, parent, cwd),
            assertCleanWorkingTree: ({ cwd }) => assertCleanWorkingTree(pi, cwd, "push"),
            readImplementationSummary: ({ cwd }) => readImplementationSummary(cwd),
            pushBranch: ({ branchName, cwd }) => pushGitBranch(pi, cwd, branchName),
            getPullRequest: ({ branchName, cwd, allowMissing }) => getPullRequestForBranch(pi, branchName, cwd, { allowMissing }),
            createPullRequest: ({ title, body, branchName, cwd }) => createPullRequest(pi, title, body, branchName, cwd),
            updatePullRequest: ({ prNumber, body, cwd }) => updatePullRequestBody(pi, prNumber, body, cwd),
            addParentComment: (targetIssueKey, body) => addIssueComment(pi, targetIssueKey, body),
          });
          ctx.ui.notify(`Pushed ${queue.parent.identifier} and synced PR ${pullRequest?.url ?? ""}.`, "success");
          return;
        }

        if (command.mode === "review") {
          const review = await reviewParentPullRequest(queue, [], {
            ensureParentBranch: ({ parent, cwd }) => ensureParentBranch(pi, parent, cwd),
            assertCleanWorkingTree: ({ cwd }) => assertCleanWorkingTree(pi, cwd, "review"),
            getPullRequest: ({ branchName, cwd, allowMissing }) => getPullRequestForBranch(pi, branchName, cwd, { allowMissing }),
            readImplementationSummary: ({ cwd }) => readImplementationSummary(cwd),
            updatePullRequest: ({ prNumber, body, cwd }) => updatePullRequestBody(pi, prNumber, body, cwd),
            runClaudeReview: ({ prompt, cwd }) => runClaudeReviewWorker(pi, prompt, cwd),
            addPullRequestComment: ({ prNumber, body, cwd }) => addPullRequestComment(pi, prNumber, body, cwd),
            addParentComment: (targetIssueKey, body) => addIssueComment(pi, targetIssueKey, body),
          });
          ctx.ui.notify(`Reviewed ${queue.parent.identifier}. PR: ${review.pullRequest?.url ?? "unknown"}.`, "success");
          return;
        }

        const runtime = await createVisibleRuntime(pi);
        const cycle = await runVisibleSchedulingCycle(pi, runtime, [queue], "manual");
        pi.appendEntry("crosby-queue-loaded", {
          issueKey,
          parentTitle: queue.parent.title,
          childCount: queue.children.length,
          childKeys: queue.children.map((child) => child.identifier),
          settledChildKeys: cycle.settled.map((entry) => entry.child.identifier),
          launchedChildKeys: cycle.launched.map((entry) => entry.child.identifier),
          loadedAt: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Crosby reconciled ${cycle.settled.length} and launched ${cycle.launched.length} worker(s) under ${queue.parent.identifier}.`,
          "success",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
