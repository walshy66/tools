import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBuildTaskList } from "./task-list.mjs";
import { createRegistryStore, readRegistry, updateRegistry } from "./registry.mjs";
import { createManagedRepository, createParentWorktree, createTaskWorktree } from "./managed-git.mjs";
import { createHerdrSupervisor } from "./supervisor.mjs";
import { createHerdrClient } from "./herdr-client.mjs";

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
  return value
    && typeof value === "object"
    && typeof value.model === "string"
    && value.model.includes("/")
    && value.thinking === "medium"
    && value.source === "orchestrator";
}

function validTaskWorktree(value) {
  return value
    && typeof value === "object"
    && [value.path, value.branch, value.baseSha].every((field) => typeof field === "string" && field.trim());
}

function taskState(task, worker) {
  if (worker?.lifecycle === "integrated") return "completed";
  if (worker?.lifecycle === "reported") return "awaiting integration";
  if (["working", "recovered"].includes(worker?.lifecycle)) return "running";
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
    tasks,
  };
}

export function formatBuildProgress(status) {
  const progress = status?.tasks ? status : summarizeBuildProgress(status);
  const marker = (state) => state === "completed" ? "✓" : state === "running" ? "▶" : state === "awaiting integration" ? "!" : state === "human gate" ? "◆" : "·";
  return [
    `Crosby ${progress.buildId}: ${progress.completed}/${progress.total} completed; ${progress.remaining} remaining; current: ${progress.currentTask ?? "none"}.`,
    ...progress.tasks.map((task) => `${marker(task.state)} ${task.id} ${task.state} — ${task.title}`),
  ].join("\n");
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
    "When finished, submit exactly one explicit crosby_worker_report terminal report. Do not report completion from idle state.",
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
  const store = createRegistryStore({
    root: registryRoot ?? path.join(source, ".pi", "crosby"),
    repositoryIdentity: repositoryIdentity ?? source,
    parentKey: build.parentBranch,
    buildId: build.buildId,
    buildFolder: build.folder,
    parentBranch: build.parentBranch,
    spaceId: workspace,
  });
  const registry = await readRegistry(store);
  return { build, registry, progress: summarizeBuildProgress({ build, registry }) };
}

export async function runBuild({ buildFolder, sourcePath, workspace, pane, agent, registryRoot, repositoryIdentity, adapters = {} } = {}) {
  const build = await loadBuild(buildFolder);
  const source = path.resolve(sourcePath ?? process.cwd());
  const identity = repositoryIdentity ?? source;
  const root = registryRoot ?? path.join(source, ".pi", "crosby");
  const ops = {
    createManagedRepository,
    createParentWorktree,
    createTaskWorktree,
    createHerdrSupervisor,
    ...adapters,
  };
  const store = createRegistryStore({
    root,
    repositoryIdentity: identity,
    parentKey: build.parentBranch,
    buildId: build.buildId,
    buildFolder: build.folder,
    parentBranch: build.parentBranch,
    spaceId: workspace,
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

  const completed = [];
  for (const task of build.tasks) {
    const current = await readRegistry(store);
    if (["blocked", "failed", "cancelled"].includes(current.queueState)) {
      throw new BuildRunnerError(`Build stopped at ${task.id}; queue is ${current.queueState}.`);
    }
    const currentWorker = current.workers?.[task.id];
    if (currentWorker?.lifecycle === "integrated" && currentWorker.report?.outcome === "complete") {
      completed.push({ task, worker: currentWorker, report: currentWorker.report });
      continue;
    }
    if (["Done", "Review"].includes(task.sourceState)) {
      if (task.sourceState === "Done") completed.push({ task, worker: currentWorker ?? null, report: currentWorker?.report ?? null });
      continue;
    }
    if (task.executionMode === "HITL") {
      throw new BuildRunnerError(`Build reached human gate ${task.id}; explicit operator participation is required and no worker was launched.`);
    }
    if (typeof adapters.onTaskStarting === "function") await adapters.onTaskStarting({ task, registry: current });
    const hasReportedCompletion = currentWorker?.lifecycle === "reported" && currentWorker.report?.outcome === "complete";
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
    let taskWorktree = currentWorker?.taskWorktree;
    if (!validTaskWorktree(taskWorktree)) {
      taskWorktree = await ops.createTaskWorktree({
        managedRepository: managed,
        parentKey: build.parentBranch,
        childKey: task.id,
        taskBranch: `${build.parentBranch}-${task.id}`,
        baseRef: parent.branch,
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
    const worker = hasReportedCompletion
      ? currentWorker
      : await supervisor.launchWorker({
          task,
          cwd: taskWorktree.path,
          prompt: taskPrompt(build, task),
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
          },
        });
    const report = hasReportedCompletion
      ? currentWorker.report
      : adapters.waitForReport
        ? await adapters.waitForReport({ task, worker, store })
        : null;
    if (!report) throw new BuildRunnerError(`Worker ${task.id} has not submitted a terminal report; queue remains stopped.`);
    if (report.outcome === "blocked") {
      const reviewedRegistry = await updateRegistry(store, (registry) => ({
        ...registry,
        queueState: "ready",
        currentTask: null,
        workers: { ...registry.workers, [task.id]: { ...registry.workers[task.id], lifecycle: "review", report } },
      }));
      if (typeof adapters.onTaskReview === "function") await adapters.onTaskReview({ task, report, registry: reviewedRegistry });
      if (typeof ops.onProgress === "function") await ops.onProgress(summarizeBuildProgress({ build, registry: reviewedRegistry }));
      continue;
    }
    if (report.outcome !== "complete") throw new BuildRunnerError(`Worker ${task.id} reported ${report.outcome}; queue stopped.`);
    if (typeof adapters.integrateTask !== "function") throw new BuildRunnerError("A task integration adapter is required before advancing the build.");
    await adapters.integrateTask({ task, taskWorktree, parentWorktree: parent, report });
    const updatedRegistry = await updateRegistry(store, (registry) => {
      const workers = { ...registry.workers, [task.id]: { ...registry.workers[task.id], lifecycle: "integrated", report } };
      return { ...registry, workers };
    });
    if (typeof adapters.onTaskIntegrated === "function") {
      await adapters.onTaskIntegrated({ task, taskWorktree, parentWorktree: parent, report, registry: updatedRegistry });
    }
    completed.push({ task, worker, report });
    if (typeof ops.onProgress === "function") {
      await ops.onProgress(summarizeBuildProgress({ build, registry: updatedRegistry }));
    }
  }
  return { build, parent, completed, registry: store };
}
