import path from "node:path";
import { createManagedRepository, createParentWorktree, createTaskWorktree } from "./managed-git.mjs";
import { createRegistryStore, readRegistry, recordWorkerRecovery, updateWorkerRecord } from "./registry.mjs";
import { validateWorkerReport } from "./worker-protocol.mjs";

export class VisibleWorkerLaunchError extends Error {
  constructor(message) {
    super(`${message} Recovery: the child can be returned to Ready to Build and relaunched from the Crosby supervisor; inspect the retained registry record and task worktree first.`);
    this.name = "VisibleWorkerLaunchError";
  }
}

export class VisibleWorkerRecoveryError extends Error {
  constructor(message) {
    super(`${message} Recovery: inspect the retained Herdr and task-worktree evidence, then resolve the child manually before another launch.`);
    this.name = "VisibleWorkerRecoveryError";
  }
}

export class VisibleWorkerReportError extends Error {
  constructor(message) {
    super(`${message} Recovery: inspect the visible Herdr worker transcript and submit a valid structured worker report before resolving the child.`);
    this.name = "VisibleWorkerReportError";
  }
}

function text(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new VisibleWorkerLaunchError(`${name} must be a non-empty string.`);
  return result;
}

function workerName(childKey) {
  return `crosby-${text(childKey, "child key").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 32);
}

function taskBranch(parentBranch, childKey) {
  return `${text(parentBranch, "parent branch")}/${text(childKey, "child key").toLowerCase()}`;
}

function activeWorker(worker) {
  return ["launching", "running", "recovering"].includes(worker?.lifecycle) && !!worker?.herdr?.agent;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

export function workerReportToExecutionResult(report, child) {
  const workerReport = validateWorkerReport(report);
  const issueKey = text(child?.identifier, "child issue key");
  const issueTitle = text(child?.title, "child issue title");

  if (workerReport.outcome === "blocked") {
    return {
      issueKey,
      issueTitle,
      outcome: "review",
      summary: workerReport.summary,
      changes: [],
      tests: [],
      requiredHumanAction: workerReport.requiredHumanAction,
      recoveryNotes: workerReport.recoveryNotes,
    };
  }

  return {
    issueKey,
    issueTitle,
    outcome: "done",
    summary: workerReport.summary,
    changes: workerReport.changes.paths,
    tests: workerReport.verification.map(({ command, result }) => `${command} (${result})`),
    recoveryNotes: workerReport.risks,
  };
}

export function createVisibleWorkerScheduler(options = {}) {
  const registryRoot = text(options.registryRoot, "registryRoot");
  const herdr = options.herdr;
  if (!herdr) throw new VisibleWorkerLaunchError("A validated Herdr client is required.");

  const dependencies = {
    createRegistryStore: options.createRegistryStore ?? createRegistryStore,
    readRegistry: options.readRegistry ?? readRegistry,
    updateWorkerRecord: options.updateWorkerRecord ?? updateWorkerRecord,
    recordWorkerRecovery: options.recordWorkerRecovery ?? recordWorkerRecovery,
    createManagedRepository: options.createManagedRepository ?? createManagedRepository,
    createParentWorktree: options.createParentWorktree ?? createParentWorktree,
    createTaskWorktree: options.createTaskWorktree ?? createTaskWorktree,
  };

  async function prepareTask({ store, parent, child, sourcePath, repositoryIdentity, existing }) {
    if (existing?.task?.path && existing?.task?.branch && existing?.task?.baseSha) return existing.task;

    const managedRepository = await dependencies.createManagedRepository({
      root: path.join(registryRoot, "managed"),
      sourcePath: text(sourcePath, "sourcePath"),
      repositoryIdentity: text(repositoryIdentity, "repositoryIdentity"),
    });
    const parentWorktree = await dependencies.createParentWorktree({
      managedRepository,
      parentKey: text(parent?.identifier, "parent issue key"),
      parentBranch: text(parent?.branchName, "parent branch"),
    });
    return dependencies.createTaskWorktree({
      managedRepository,
      parentKey: text(parent?.identifier, "parent issue key"),
      childKey: text(child?.identifier, "child issue key"),
      taskBranch: taskBranch(parentWorktree.branch, child.identifier),
      baseRef: parentWorktree.branch,
    });
  }

  async function persistLaunchFailure(store, childKey, worker, error, tab) {
    let cleanupError;
    if (tab?.tab) {
      try {
        await herdr.closeTaskTab({ tab: tab.tab });
      } catch (closeError) {
        cleanupError = describe(closeError);
      }
    }

    await dependencies.updateWorkerRecord(store, childKey, {
      ...worker,
      lifecycle: "launch-failed",
      launchError: describe(error),
      ...(cleanupError ? { cleanupError } : {}),
    });
    return cleanupError;
  }

  async function start({ store, parent, child, prompt, workspace, worker, recovered }) {
    const childKey = text(child?.identifier, "child issue key");
    const name = workerName(childKey);
    let tab;

    try {
      const task = worker.task;
      if (!task?.path || !task?.branch || !task?.baseSha) throw new VisibleWorkerLaunchError(`Task worktree for ${childKey} was not prepared.`);

      await dependencies.updateWorkerRecord(store, childKey, {
        ...worker,
        lifecycle: "launching",
        task,
        attemptCount: Number(worker.attemptCount ?? 0) + 1,
      });
      tab = await herdr.createTaskTab({ workspace: text(workspace, "workspace"), label: childKey, cwd: task.path, focus: false });
      const agent = await herdr.startPiAgent({ pane: tab.pane, name });
      const herdrRecord = { workspace: tab.workspace, tab: tab.tab, pane: agent.pane, agent: agent.name };
      worker = await dependencies.updateWorkerRecord(store, childKey, {
        ...worker,
        lifecycle: "launching",
        attemptCount: Number(worker.attemptCount ?? 0) + 1,
        task,
        herdr: herdrRecord,
      });
      await herdr.promptAgent({ agent: agent.name, prompt: text(prompt, "worker prompt"), wait: false });

      const record = await dependencies.updateWorkerRecord(store, childKey, {
        lifecycle: "running",
        attemptCount: Number(worker.attemptCount ?? 0),
        task,
        herdr: herdrRecord,
      });
      return { worker: record, adopted: false, recovered: recovered === true };
    } catch (error) {
      const cleanupError = await persistLaunchFailure(store, childKey, worker, error, tab);
      const cleanupDetail = cleanupError ? ` Herdr cleanup also failed: ${cleanupError}` : "";
      throw new VisibleWorkerLaunchError(`Could not start visible Herdr worker for ${childKey}: ${describe(error)}.${cleanupDetail}`);
    }
  }

  async function recover({ store, parent, child, prompt, workspace, worker }) {
    const childKey = text(child?.identifier, "child issue key");
    let recoveredWorker = worker;
    try {
      recoveredWorker = await dependencies.recordWorkerRecovery(store, childKey, "Recorded Herdr worker was unavailable during reconciliation.");
      return await start({ store, parent, child, prompt, workspace, worker: recoveredWorker, recovered: true });
    } catch (error) {
      const note = `Second recovery failure: ${describe(error)}`;
      await dependencies.updateWorkerRecord(store, childKey, {
        ...recoveredWorker,
        lifecycle: "review-required",
        recoveryNotes: [...(recoveredWorker.recoveryNotes ?? []), note],
      });
      throw new VisibleWorkerRecoveryError(`Worker ${childKey} cannot be recovered automatically: ${describe(error)}.`);
    }
  }

  return {
    async waitForReport(worker) {
      const agent = text(worker?.herdr?.agent, "recorded Herdr agent");
      await herdr.waitForAgent({ agent, until: ["idle", "done", "blocked"] });
      const terminal = await herdr.readAgent({ agent, lines: 2000 });
      let report;
      try {
        report = validateWorkerReport(JSON.parse(String(terminal.text ?? "").trim()));
      } catch (error) {
        throw new VisibleWorkerReportError(`Visible worker ${agent} did not return a valid structured worker report: ${describe(error)}`);
      }
      return report;
    },

    async launch({ parent, child, prompt, sourcePath, repositoryIdentity, workspace }) {
      const parentKey = text(parent?.identifier, "parent issue key");
      const childKey = text(child?.identifier, "child issue key");
      const store = dependencies.createRegistryStore({
        root: registryRoot,
        repositoryIdentity: text(repositoryIdentity, "repositoryIdentity"),
        parentKey,
      });
      const registry = await dependencies.readRegistry(store);
      const existing = registry.workers?.[childKey];

      if (activeWorker(existing)) {
        try {
          await herdr.inspectAgent({ agent: existing.herdr.agent });
          const adopted = await dependencies.updateWorkerRecord(store, childKey, { lifecycle: "running", adoptedAt: new Date().toISOString() });
          return { worker: adopted, adopted: true, recovered: false };
        } catch {
          return recover({ store, parent, child, prompt, workspace, worker: existing });
        }
      }

      const task = await prepareTask({ store, parent, child, sourcePath, repositoryIdentity, existing });
      const worker = {
        ...existing,
        lifecycle: "launching",
        task,
        attemptCount: Number(existing?.attemptCount ?? 0),
      };
      await dependencies.updateWorkerRecord(store, childKey, worker);
      return start({ store, parent, child, prompt, workspace, worker, recovered: false });
    },
  };
}
