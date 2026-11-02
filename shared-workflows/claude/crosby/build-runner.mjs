import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBuildTaskList } from "./task-list.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";
import { createManagedRepository, createParentWorktree, createTaskWorktree, readWorktreeHead } from "./managed-git.mjs";
import { createHerdrSupervisor } from "./supervisor.mjs";
import { contractHash } from "./quality-gates.mjs";
import { acquireRunLease } from './run-lease.mjs';
import { resolveRegistrySpace } from './registry-discovery.mjs';
import { CLAUDE_CROSBY_ROOT, validClaudeSelection } from './claude-launch.mjs';

export class BuildRunnerError extends Error {
  constructor(message) {
    super(`${message} Recovery: inspect the durable build registry and retained worker evidence before retrying.`);
    this.name = "BuildRunnerError";
  }
}

export function parseBuildCommandArgs(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const mode = tokens[0] ?? "run";
  if (!["run", "resume", "status"].includes(mode)) {
    throw new BuildRunnerError("Usage: /crosby run <build-folder> | /crosby resume <build-folder> | /crosby status <build-folder>.");
  }
  if (tokens.length !== 2) throw new BuildRunnerError(`Usage: /crosby ${mode} <build-folder>.`);
  return { mode, buildFolder: tokens[1] };
}

function validModelSelection(value) {
  return validClaudeSelection(value);
}

function validTaskWorktree(value) {
  return value
    && typeof value === "object"
    && [value.path, value.branch, value.baseSha].every((field) => typeof field === "string" && field.trim());
}

function taskState(task, worker) {
  if (["integrated", "human-completed", "external-completed"].includes(worker?.lifecycle)) return "completed";
  if (worker?.lifecycle === "reported") return "awaiting integration";
  if (["working", "recovered", "repairing"].includes(worker?.lifecycle)) return "running";
  if (worker?.lifecycle === "paused") return "paused";
  if (["blocked", "review", "failed", "cancelled", "review-required", "launch-failed"].includes(worker?.lifecycle)) return worker.lifecycle;
  return task.executionMode === "HITL" ? "human gate" : "pending";
}

function firstOutstandingTask(build, workers) {
  return build.tasks.find((task) => workers?.[task.id]?.lifecycle !== "integrated")?.id ?? null;
}

export function summarizeBuildProgress({ build, registry } = {}) {
  if (!build?.buildId || !Array.isArray(build.tasks) || !registry) throw new BuildRunnerError("Build progress requires a loaded build and registry.");
  const tasks = build.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    state: taskState(task, registry.workers?.[task.id]),
  }));
  const completed = tasks.filter((task) => task.state === "completed").length;
  return {
    buildId: build.buildId,
    total: tasks.length,
    completed,
    remaining: tasks.length - completed,
    currentTask: registry.currentTask ?? firstOutstandingTask(build, registry.workers),
    queueState: registry.queueState,
    waiting: registry.blockers?.[0] ?? Object.values(registry.workers ?? {}).find((worker) => ["review", "blocked", "review-required"].includes(worker.lifecycle))?.report,
    repairing: Object.values(registry.workers ?? {}).find((worker) => worker.lifecycle === 'repairing'),
    tasks,
  };
}

export function formatBuildProgress(status) {
  const progress = status?.tasks ? status : summarizeBuildProgress(status);
  const waiting = progress.waiting;
  const detail = progress.repairing ? ` Repair attempt ${progress.repairing.repairAttempts}/3: ${progress.repairing.pendingFindings?.summary ?? 'fixing verification findings'}.` : waiting ? ` Waiting: ${waiting.summary ?? "Review required"}; action: ${waiting.requiredHumanAction ?? "Inspect retained evidence and resume"}.` : "";
  return `Crosby ${progress.buildId}: ${progress.completed}/${progress.total} completed; ${progress.remaining} remaining; current: ${progress.currentTask ?? "none"}.${detail}`.replace(/\s+/g, " ").trim();
}

function taskPrompt(build, task) {
  const taskListPath = path.join(build.folder, "tasks.md");
  return [
    `You are the Crosby worker for ${build.buildId}, ${task.id}: ${task.title}.`,
    `Read the complete task contract from ${taskListPath} and follow the ${task.id} outcome, acceptance criteria, instructions, and guardrails exactly.`,
    `Your complete allowed file scope is: ${task.fileScope.join(", ")}. Do not edit or commit any other path.`,
    "If acceptance requires an out-of-scope path, submit a blocked report naming the missing path instead of changing it.",
    "Read the applicable AGENTS.md chain before editing and work only in the assigned worktree.",
    "Before reporting, compare the complete task diff with the declared file scope and run every declared verification command; do not report skipped required checks as complete.",
    "Stage all completed work with git add and create at least one commit whose message references the task ID before reporting complete.",
    "Verify git status --porcelain is empty before reporting complete and include the commit hash in the completion report.",
    "If you cannot commit the work or leave the worktree clean, submit a blocked report requiring human review instead of reporting complete.",
    "When finished, submit exactly one explicit crosby_worker_report terminal report (the crosby MCP tool), then stop. Do not report completion from idle state.",
  ].join("\n");
}

export async function loadBuild(buildFolder) {
  const folder = path.resolve(String(buildFolder ?? ""));
  const markdown = await readFile(path.join(folder, "tasks.md"), "utf8");
  return { ...parseBuildTaskList(markdown), folder };
}

export async function readBuildStatus({ buildFolder, sourcePath, workspace, registryRoot, repositoryIdentity } = {}) {
  const build = await loadBuild(buildFolder);
  const source = path.resolve(sourcePath ?? process.cwd());
  const spaceId = await resolveRegistrySpace({ root: registryRoot ?? CLAUDE_CROSBY_ROOT, repositoryIdentity: repositoryIdentity ?? source, parentKey: build.parentBranch, buildId: build.buildId, workspace });
  const store = createRegistryStore({
    root: registryRoot ?? CLAUDE_CROSBY_ROOT,
    repositoryIdentity: repositoryIdentity ?? source,
    parentKey: build.parentBranch,
    buildId: build.buildId,
    buildFolder: build.folder,
    parentBranch: build.parentBranch,
    spaceId,
  });
  const registry = await readRegistry(store);
  return { build, registry, progress: summarizeBuildProgress({ build, registry }) };
}

/**
 * Required gates:
 * verifyTask({task, taskWorktree, parentWorktree, worker, report, store, build})
 *   -> {outcome: 'passed'|'changes-required'|'blocked', summary,
 *       requiredHumanAction?, reports, revision, contractHash}.
 * Its exact result is persisted as worker.gates and passed to
 * integrateTask({task, taskWorktree, parentWorktree, report, gates}).
 * verifyParent({build, parentWorktree, store}) -> the same outcome/report shape;
 * only passed makes readyForReview true. No parent browser contract is inferred.
 *
 * Optional beforeTaskResume({task, worker, store}) runs before retained builder
 * reuse, every verification, and every repair. Return void/{outcome:'passed'}
 * to proceed; throw or return a non-passed result to block safely.
 * Optional repairTask({task, taskWorktree, parentWorktree, worker, findings,
 * prompt, store, build}) -> worker; guide/relaunch only, do not await completion.
 * waitForReport({task, worker, store}) must then return a NEW terminal report.
 * Without repairTask, the supervisor guides the retained agent or relaunches it.
 *
 * Pure HITL approval: worker.humanApproval={approved:true, approvedBy, approvedAt}.
 * Legacy external Done (no worker execution evidence) additionally requires
 * worker.externalCompletion={confirmed:true, recordedBy, recordedAt, reason}.
 * Parent changes-required is auto-routed only with repairable:true and a valid
 * repairTaskId. prepareParentRepair({task, worker, parentWorktree, store}) must
 * safely sync the retained child and return {path, branch, baseSha}; the runner
 * validates the retained identity and persists it as worker.taskWorktree.
 * A void result uses an identity already persisted by the adapter. Throw or
 * return a non-passed outcome to block. Its worker
 * already has the shared attempt consumed and report/completionReport/gates
 * invalidated. Failed/interrupted preparation leaves
 * parentRepairPreparationRequired:true, requiring safe recovery before resume.
 * worker.parentRepairPending marks deliberate repairs for onTaskStarting,
 * including closed source children, and clears only after successful integration.
 * Each successful preparation reruns the child and parent gates via an explicit
 * loop; other completed children are retained. No parent closure is performed.
 * resume:true retries review states; it never resets repairAttempts or skips gates.
 */
export async function runBuild(options = {}) {
  const build = await loadBuild(options.buildFolder);
  const source = path.resolve(options.sourcePath ?? process.cwd());
  const release = await acquireRunLease({ root: options.registryRoot ?? CLAUDE_CROSBY_ROOT, repositoryIdentity: options.repositoryIdentity ?? source, parentKey: build.parentBranch, buildId: build.buildId });
  try { return await runBuildWithLease(options); }
  finally { await release(); }
}

async function runBuildWithLease({ buildFolder, sourcePath, workspace, pane, agent, registryRoot, repositoryIdentity, resume = false, adapters = {} } = {}) {
  const build = await loadBuild(buildFolder);
  const source = path.resolve(sourcePath ?? process.cwd());
  const identity = repositoryIdentity ?? source;
  const root = registryRoot ?? CLAUDE_CROSBY_ROOT;
  const ops = {
    createManagedRepository,
    createParentWorktree,
    createTaskWorktree,
    readWorktreeHead,
    createHerdrSupervisor,
    ...adapters,
  };
  const spaceId = await resolveRegistrySpace({ root, repositoryIdentity: identity, parentKey: build.parentBranch, buildId: build.buildId, workspace });
  const store = createRegistryStore({
    root,
    repositoryIdentity: identity,
    parentKey: build.parentBranch,
    buildId: build.buildId,
    buildFolder: build.folder,
    parentBranch: build.parentBranch,
    spaceId,
  });
  const managed = await ops.createManagedRepository({ root, sourcePath: source, repositoryIdentity: identity });
  const parent = await ops.createParentWorktree({
    managedRepository: managed,
    parentKey: build.parentBranch,
    parentBranch: build.parentBranch,
    baseRef: managed.sourceHead ?? undefined,
  });
  await updateRegistry(store, (registry) => ({ ...registry, parentWorktree: parent }));
  const supervisor = ops.createHerdrSupervisor({ client: adapters.herdrClient, store, emitLifecycle: adapters.emitLifecycle });
  if (!supervisor || typeof supervisor.ensureSupervisor !== "function") throw new BuildRunnerError("A Herdr supervisor adapter is required.");
  await supervisor.ensureSupervisor({ workspace, pane, agent });
  const initialRegistry = await updateRegistry(store, (registry) => ({
    ...registry,
    readyForReview: false,
    blockers: [],
    tasks: Object.fromEntries(build.tasks.map((task) => [task.id, structuredClone(task)])),
  }));
  const hasExecutionEvidence = Object.values(initialRegistry.workers ?? {}).some((worker) =>
    worker?.agent
    || worker?.report
    || !["prepared", "launch-failed"].includes(worker?.lifecycle),
  );
  if (managed.sourceHead && parent.baseSha && parent.baseSha !== managed.sourceHead && !hasExecutionEvidence) {
    throw new BuildRunnerError("The managed parent predates committed source HEAD and has no accepted execution progress; explicit cleanup is required before a safe rerun.");
  }

  // Each rerun consumes a persisted child repair attempt before preparation.
  while (true) {
    const completed = [];
    const blockers = [];
    async function review(task, report) {
      report = { ...report, summary: report.summary || "Task requires review.",
        requiredHumanAction: report.requiredHumanAction || "Inspect retained evidence and explicitly resume." };
      blockers.push({ taskId: task.id, ...report });
      const registry = await updateRegistry(store, (registry) => ({
        ...registry, queueState: "ready", currentTask: null,
        workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id], lifecycle: "review", report,
          evidence: [...(registry.workers[task.id]?.evidence ?? []), report] } },
      }));
      try {
        if (adapters.onTaskReview) await adapters.onTaskReview({ task, report, registry,
          taskWorktree: registry.workers[task.id].taskWorktree, parentWorktree: parent });
      } catch (error) {
        await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
          [task.id]: { ...registry.workers[task.id], reviewUpdateError: String(error.message ?? error) } } }));
      }
      if (ops.onProgress) await ops.onProgress(summarizeBuildProgress({ build, registry }));
    }
    async function verify(name, input) {
      try {
        if (typeof adapters[name] !== "function") throw new Error(`Required ${name} adapter is missing.`);
        const result = await adapters[name](input);
        if (!["passed", "changes-required", "blocked"].includes(result?.outcome)) throw new Error(`Invalid ${name} outcome.`);
        return result;
      } catch (error) {
        return { outcome: "blocked", summary: error.message, requiredHumanAction: `Inspect ${name} evidence and explicitly resume.`, reports: [] };
      }
    }
    async function beforeTaskResume(task, worker) {
      try {
        const result = await adapters.beforeTaskResume?.({ task, worker, store });
        if (result && result.outcome !== "passed") return { ...result, outcome: "blocked" };
        return null;
      } catch (error) {
        return { outcome: "blocked", summary: String(error.message ?? error), requiredHumanAction: "Resolve retained gate agents before resuming." };
      }
    }
    for (const task of build.tasks) {
      const current = await readRegistry(store);

      const currentWorker = current.workers?.[task.id];
      if (task.contractError) {
        await review(task, { outcome: "blocked", summary: String(task.contractError), requiredHumanAction: "Correct the task contract and explicitly resume." });
        continue;
      }
      const unmet = (task.dependencies ?? []).filter((id) => !completed.some((entry) => entry.task.id === id));
      if (unmet.length) {
        await review(task, { outcome: "blocked", summary: `Waiting for prerequisites: ${unmet.join(", ")}`, requiredHumanAction: "Integrate or explicitly complete prerequisites, then resume.", dependencyBlocked: true });
        continue;
      }
      if (currentWorker?.lifecycle === "integrated" && currentWorker.report?.outcome === "complete") {
        if (currentWorker.gates?.outcome !== "passed" || currentWorker.gates.contractHash !== contractHash(task)) {
          await review(task, { outcome: "blocked", summary: "Integrated task contract changed or has no matching saved gates.", requiredHumanAction: "Explicitly reopen the task for review, inspect retained work, then resume." });
          await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
            [task.id]: { ...registry.workers[task.id], lifecycle: "review-required", completionReport: currentWorker.report } } }));
          continue;
        }
        if (task.sourceState !== 'Done' && currentWorker.sourceFinalized !== true && adapters.onTaskIntegrated) {
          await adapters.onTaskIntegrated({ task, taskWorktree: currentWorker.taskWorktree, parentWorktree: parent, report: currentWorker.report, registry: current });
          await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id], sourceFinalized: true } } }));
        }
        completed.push({ task, worker: currentWorker, report: currentWorker.report });
        continue;
      }
      const external = currentWorker?.externalCompletion;
      if (task.sourceState === "Done" && external?.confirmed === true && external.recordedBy && external.recordedAt && external.reason
        && !currentWorker.taskWorktree && !currentWorker.report && !currentWorker.completionReport && !currentWorker.agent) {
        await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
          [task.id]: { ...registry.workers[task.id], lifecycle: "external-completed", completionBasis: "source-done-external" } } }));
        completed.push({ task, worker: currentWorker, report: external });
        continue;
      }
      if (task.sourceState === "Done" && task.executionMode === "AFK"
        && !currentWorker?.taskWorktree && !currentWorker?.gates) {
        await review(task, { outcome: "blocked", summary: "Legacy closed AFK task has no durable worktree or gates.",
          requiredHumanAction: "Explicitly reopen the source issue or record confirmed external completion; do not rebuild closed work implicitly." });
        continue;
      }
      if (task.executionMode === "HITL" && !currentWorker?.taskWorktree && !currentWorker?.completionReport && !currentWorker?.agent && currentWorker?.report?.outcome !== "complete") {
        const approval = currentWorker?.humanApproval;
        if (task.sourceState === "Done" || (approval?.approved === true && approval.approvedBy && approval.approvedAt)) {
          await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
            [task.id]: { ...registry.workers[task.id], lifecycle: "human-completed", completionBasis: task.sourceState === "Done" ? "source-done-hitl" : "human-approval" } } }));
          completed.push({ task, worker: currentWorker, report: approval ?? null });
        } else {
          await review(task, { outcome: "blocked", summary: "This task requires human-in-the-loop execution.", requiredHumanAction: task.outcome });
        }
        continue;
      }
      if (!resume && ["blocked", "review", "failed", "cancelled", "review-required", "launch-failed", "repairing"].includes(currentWorker?.lifecycle)) {
        blockers.push({ taskId: task.id, ...currentWorker.report, requiredHumanAction: currentWorker.report?.requiredHumanAction ?? "Inspect evidence and explicitly resume." });
        continue;
      }
      if (currentWorker?.parentRepairPreparationRequired) {
        await review(task, { outcome: "blocked", summary: "Parent repair preparation is incomplete.",
          requiredHumanAction: "Safely complete parent repair preparation and clear parentRepairPreparationRequired before resuming." });
        continue;
      }
      if (currentWorker) {
        const guard = await beforeTaskResume(task, currentWorker);
        if (guard) { await review(task, guard); continue; }
      }
      if (resume && currentWorker?.report?.outcome !== "complete") {
        await updateRegistry(store, (registry) => ({ ...registry, queueState: "ready", currentTask: null,
          workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id], report: null } } }));
      }
      if (typeof adapters.onTaskStarting === "function") await adapters.onTaskStarting({ task, registry: current });
      const savedReport = currentWorker?.report?.outcome === "complete" ? currentWorker.report : currentWorker?.completionReport;
      const hasReportedCompletion = savedReport?.outcome === "complete";
      if (hasReportedCompletion && !validTaskWorktree(currentWorker.taskWorktree)) {
        throw new BuildRunnerError(`Worker ${task.id} reported completion without a persisted task worktree identity.`);
      }
      let modelSelection = currentWorker?.modelSelection;
      if (!hasReportedCompletion && !validModelSelection(modelSelection)) {
        if (typeof ops.selectTaskModel !== "function") {
          throw new BuildRunnerError(`Task ${task.id} requires an orchestrator model selection before worker launch.`);
        }
        modelSelection = await ops.selectTaskModel({ task, build });
        if (!validModelSelection(modelSelection)) {
          throw new BuildRunnerError(`Task ${task.id} received an invalid orchestrator model selection.`);
        }
        await updateRegistry(store, (registry) => ({
          ...registry,
          workers: {
            ...registry.workers,
            [task.id]: { ...(registry.workers[task.id] ?? {}), taskId: task.id, modelSelection },
          },
        }));
      }
      let parentHead = parent.baseSha ?? "initial-parent-head";
      try {
        parentHead = await ops.readWorktreeHead({ cwd: parent.path });
      } catch (error) {
        if (!parentHead) throw error;
      }
      const resumableWorktree = currentWorker;
      let taskWorktree = resumableWorktree && validTaskWorktree(currentWorker.taskWorktree) ? currentWorker.taskWorktree : null;
      if (!taskWorktree) {
        const attempt = parentHead.slice(0, 12);
        taskWorktree = await ops.createTaskWorktree({
          managedRepository: managed,
          parentKey: build.parentBranch,
          childKey: `${task.id}-${attempt}`,
          taskBranch: `${build.parentBranch}-${task.id}-${attempt}`,
          baseRef: parentHead,
        });
        await updateRegistry(store, (registry) => ({
          ...registry,
          workers: {
            ...registry.workers,
            [task.id]: {
              ...(registry.workers[task.id] ?? {}),
              taskId: task.id,
              lifecycle: registry.workers[task.id]?.lifecycle ?? "prepared",
              taskWorktree,
            },
          },
        }));
      }
      let worker, report;
      try {
        worker = hasReportedCompletion
          ? currentWorker
          : currentWorker?.pendingFindings && adapters.repairTask
            ? await adapters.repairTask({ task, taskWorktree, parentWorktree: parent, worker: currentWorker,
                findings: currentWorker.pendingFindings, prompt: `${taskPrompt(build, task)}
  Repair retained findings and submit a NEW completion report:
  ${JSON.stringify(currentWorker.pendingFindings)}`, store, build })
            : currentWorker?.pendingFindings && currentWorker.agent && supervisor.guideWorker
              ? await supervisor.guideWorker(task.id, `${taskPrompt(build, task)}
  Repair retained findings and submit a NEW completion report:
  ${JSON.stringify(currentWorker.pendingFindings)}`)
              : await supervisor.launchWorker({
              task,
              cwd: taskWorktree.path,
              prompt: taskPrompt(build, task) + (currentWorker?.pendingFindings ? `\nResolve retained verification findings before submitting a NEW completion report:\n${JSON.stringify(currentWorker.pendingFindings)}` : ""),
              modelSelection,
              env: {
                CROSBY_REGISTRY_ROOT: root,
                CROSBY_REPOSITORY_ID: identity,
                CROSBY_PARENT_KEY: build.parentBranch,
                CROSBY_TASK_KEY: task.id,
                CROSBY_BUILD_ID: build.buildId,
                CROSBY_BUILD_FOLDER: build.folder,
                CROSBY_PARENT_BRANCH: build.parentBranch,
                HERDR_WORKSPACE_ID: workspace,
            CROSBY_SPACE_ID: spaceId,
              },
            });
        report = hasReportedCompletion
          ? savedReport
          : adapters.waitForReport
            ? await adapters.waitForReport({ task, worker, store })
            : null;
      } catch (error) {
        report = { outcome: "blocked", summary: error.message, requiredHumanAction: "Inspect retained builder and explicitly resume." };
      }
      if (report?.outcome !== "complete") {
        await review(task, { ...(report ?? {}), outcome: report?.outcome ?? "blocked",
          summary: report?.summary ?? "Builder interrupted without a completion report.",
          requiredHumanAction: report?.requiredHumanAction ?? "Inspect retained builder evidence and explicitly resume." });
        continue;
      }
      let verification;
      while (report?.outcome === "complete") {
        await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
          [task.id]: { ...registry.workers[task.id], completionReport: report } } }));
        worker = { ...worker, ...(await readRegistry(store)).workers[task.id] };
        const guard = await beforeTaskResume(task, worker);
        if (guard) { verification = guard; break; }
        verification = await verify("verifyTask", { task, taskWorktree, parentWorktree: parent, worker, report, store, build });
        await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
          [task.id]: { ...registry.workers[task.id], completionReport: report, gates: verification } } }));
        if (verification.outcome !== "changes-required") break;
        const persisted = (await readRegistry(store)).workers[task.id];
        if ((persisted.repairAttempts ?? 0) >= 3) {
          verification = { ...verification, requiredHumanAction: "Automatic repair limit (3) reached. Inspect findings and repair manually before resuming." };
          break;
        }
        const repairGuard = await beforeTaskResume(task, (await readRegistry(store)).workers[task.id]);
        if (repairGuard) { verification = repairGuard; break; }
        const findings = verification;
        const repaired = await updateRegistry(store, (registry) => ({ ...registry, queueState: "ready", currentTask: null,
          workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id],
            repairAttempts: (registry.workers[task.id].repairAttempts ?? 0) + 1,
            evidence: [...(registry.workers[task.id].evidence ?? []), findings, { ...report, kind: "builder-completion" }],
            report: null, completionReport: null, lifecycle: "repairing", pendingFindings: findings } } }));
        if (ops.onProgress) await ops.onProgress(summarizeBuildProgress({ build, registry: repaired }));
        const prompt = `${taskPrompt(build, task)}
  Repair the following verification findings in this same worktree, then submit a NEW completion report:
  ${JSON.stringify(findings)}`;
        try {
          worker = adapters.repairTask
            ? await adapters.repairTask({ task, taskWorktree, parentWorktree: parent, worker: { ...worker, ...repaired.workers[task.id] }, findings, prompt, store, build })
            : worker?.agent && supervisor.guideWorker
              ? await supervisor.guideWorker(task.id, prompt)
              : await supervisor.launchWorker({ task, cwd: taskWorktree.path, prompt, modelSelection, env: {
                CROSBY_REGISTRY_ROOT: root, CROSBY_REPOSITORY_ID: identity, CROSBY_PARENT_KEY: build.parentBranch,
                CROSBY_TASK_KEY: task.id, CROSBY_BUILD_ID: build.buildId, CROSBY_BUILD_FOLDER: build.folder,
                CROSBY_PARENT_BRANCH: build.parentBranch, HERDR_WORKSPACE_ID: workspace, CROSBY_SPACE_ID: spaceId,
              } });
          report = await adapters.waitForReport?.({ task, worker, store });
        } catch (error) {
          report = { outcome: "blocked", summary: error.message, requiredHumanAction: "Inspect retained builder and resume." };
        }
        if (report?.outcome !== "complete") verification = report ?? { outcome: "blocked", summary: "Repair interrupted before a new completion report.", requiredHumanAction: "Inspect builder and explicitly resume." };
      }
      if (verification.outcome !== "passed") {
        await review(task, verification);
        continue;
      }
      try {
        if (typeof adapters.integrateTask !== "function") throw new BuildRunnerError("A task integration adapter is required before advancing the build.");
        await adapters.integrateTask({ task, taskWorktree, parentWorktree: parent, report, gates: verification });
      } catch (error) {
        const reviewReport = {
          outcome: "blocked",
          summary: `Worker completed, but Crosby could not integrate the task: ${error instanceof Error ? error.message : String(error)}`,
          requiredHumanAction: `Inspect the retained ${task.id} worktree, reconcile the declared file scope or changes, then approve the task for integration.`,
          recoveryNotes: ["The worker commit and worktree were retained. Inspect the parent for any partial integration before retrying."],
          requestHerdrBlocked: true,
        };
        await review(task, reviewReport);
        continue;
      }
      const updatedRegistry = await updateRegistry(store, (registry) => {
        const workers = { ...registry.workers, [task.id]: { ...registry.workers[task.id], lifecycle: "integrated", report, parentRepairPending: false, sourceFinalized: false } };
        return { ...registry, workers };
      });
      if (typeof adapters.onTaskIntegrated === "function") {
        await adapters.onTaskIntegrated({ task, taskWorktree, parentWorktree: parent, report, registry: updatedRegistry });
        await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id], sourceFinalized: true } } }));
      }
      completed.push({ task, worker, report });
      if (typeof ops.onProgress === "function") {
        await ops.onProgress(summarizeBuildProgress({ build, registry: updatedRegistry }));
      }
    }
    let readyForReview = false;
    if (completed.length === build.tasks.length && !blockers.length) {
      let parentVerification = build.contractError
        ? { outcome: "blocked", summary: String(build.contractError), requiredHumanAction: "Correct the parent review contract, then resume.", reports: [] }
        : await verify("verifyParent", { build, parentWorktree: parent, store });
      await updateRegistry(store, (registry) => ({ ...registry, parentVerification,
        parentEvidence: [...(registry.parentEvidence ?? []), parentVerification], readyForReview: false }));
      if (parentVerification.outcome === "changes-required") {
        const task = build.tasks.find((task) => task.id === parentVerification.repairTaskId);
        let worker = task && (await readRegistry(store)).workers[task.id];
        const attributable = parentVerification.repairable === true && task && !task.contractError
          && worker?.lifecycle === "integrated" && validTaskWorktree(worker.taskWorktree);
        if (attributable && (worker.repairAttempts ?? 0) < 3 && typeof adapters.prepareParentRepair === "function") {
          const guard = await beforeTaskResume(task, worker);
          if (guard) {
            parentVerification = guard;
          } else {
            const findings = parentVerification;
            const prepared = await updateRegistry(store, (registry) => ({ ...registry, queueState: "ready", currentTask: null,
              readyForReview: false, blockers: [], workers: { ...registry.workers, [task.id]: {
                ...registry.workers[task.id], repairAttempts: (registry.workers[task.id].repairAttempts ?? 0) + 1,
                evidence: [...(registry.workers[task.id].evidence ?? []), findings, { ...registry.workers[task.id].report, kind: "builder-completion" },
                  { ...registry.workers[task.id].gates, kind: "superseded-gates" }],
                lifecycle: "repairing", pendingFindings: findings, parentRepairPending: true, parentRepairPreparationRequired: true,
                report: null, completionReport: null, gates: null,
              } } }));
            completed.splice(completed.findIndex((entry) => entry.task.id === task.id), 1);
            worker = prepared.workers[task.id];
            if (ops.onProgress) await ops.onProgress(summarizeBuildProgress({ build, registry: prepared }));
            try {
              const preparation = await adapters.prepareParentRepair({ task, worker, parentWorktree: parent, store });
              if (preparation?.outcome && preparation.outcome !== "passed") throw new Error(preparation.summary || "Parent repair preparation blocked.");
              const synced = (await readRegistry(store)).workers[task.id];
              const taskWorktree = preparation ?? synced?.taskWorktree;
              if (!validTaskWorktree(taskWorktree) || taskWorktree.path !== worker.taskWorktree.path
                || taskWorktree.branch !== worker.taskWorktree.branch) throw new Error("Parent repair must retain the same valid child worktree.");
              await updateRegistry(store, (registry) => ({ ...registry, workers: { ...registry.workers,
                [task.id]: { ...registry.workers[task.id], taskWorktree, parentRepairPreparationRequired: false,
                  report: null, completionReport: null, gates: null, pendingFindings: findings } } }));
              resume = true;
              continue;
            } catch (error) {
              parentVerification = { outcome: "blocked", summary: `Parent repair preparation failed: ${error.message ?? error}`,
                requiredHumanAction: "Inspect parent and retained child; safely complete preparation before explicitly resuming.", reports: findings.reports };
              await review(task, parentVerification);
            }
          }
        } else {
          parentVerification = { ...parentVerification, outcome: "blocked",
            requiredHumanAction: attributable && (worker.repairAttempts ?? 0) >= 3
              ? "Automatic repair limit (3) reached. Inspect parent findings and repair manually."
              : "Confirm child-scope attribution and provide safe prepareParentRepair before retrying; otherwise resolve manually." };
        }
      }
      readyForReview = parentVerification.outcome === "passed";
      if (!readyForReview) blockers.push({ taskId: null, ...parentVerification });
      await updateRegistry(store, (registry) => ({ ...registry, parentVerification }));
    }
    await updateRegistry(store, (registry) => ({ ...registry, readyForReview, blockers }));
    return { build, parent, completed, registry: store, readyForReview, blockers };
  }
}
