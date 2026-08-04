import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeScopes } from "./task-contract.mjs";

export class ManagedGitError extends Error {
  constructor(message) {
    super(`${message} Recovery: retain the task worktree and branch for inspection, then resolve the issue manually before retrying integration.`);
    this.name = "ManagedGitError";
  }
}

function managedGitError(message) {
  throw new ManagedGitError(message);
}

function text(value, name) {
  const result = String(value ?? "").trim();
  if (!result) managedGitError(`${name} must be provided.`);
  return result;
}

function safeName(value) {
  return createHash("sha256").update(text(value, "repository identity")).digest("hex").slice(0, 24);
}

async function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(args, cwd, options = {}) {
  const result = await run("git", args, { cwd });
  if (result.code !== 0 && !options.allowFailure) {
    managedGitError(`Git ${args.join(" ")} failed in ${cwd ?? process.cwd()}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result;
}

async function gitOutput(args, cwd) {
  return (await git(args, cwd)).stdout.trim();
}

async function existingWorktree(pathname) {
  const result = await git(["-C", pathname, "rev-parse", "--is-inside-work-tree"], undefined, { allowFailure: true });
  return result.code === 0 && result.stdout.trim() === "true";
}

async function copyCommitIdentity(sourcePath, barePath) {
  for (const key of ["user.name", "user.email"]) {
    const result = await git(["-C", sourcePath, "config", "--get", key], undefined, { allowFailure: true });
    if (result.code === 0 && result.stdout.trim()) await git(["-C", barePath, "config", key, result.stdout.trim()]);
  }
}

export async function createManagedRepository({ root, sourcePath, sourceRemote, repositoryIdentity } = {}) {
  const managedRoot = text(root, "root");
  const source = text(sourcePath ?? sourceRemote, "sourcePath or sourceRemote");
  const identity = String(repositoryIdentity ?? source).trim();
  const barePath = path.join(managedRoot, "sources", `${safeName(identity)}.git`);
  const exists = await git(["-C", barePath, "rev-parse", "--is-bare-repository"], undefined, { allowFailure: true });
  if (exists.code !== 0) {
    await mkdir(path.dirname(barePath), { recursive: true });
    await git(["clone", "--bare", source, barePath]);
  } else if (exists.stdout.trim() !== "true") {
    managedGitError(`Managed source ${barePath} is not a bare repository.`);
  }
  await git(["-C", barePath, "remote", "set-url", "origin", source]);
  await git(["-C", barePath, "fetch", "origin", "--prune"]);
  if (sourcePath) await copyCommitIdentity(sourcePath, barePath);
  const sourceHead = sourcePath ? await gitOutput(["-C", sourcePath, "rev-parse", "HEAD"]) : null;
  return {
    root: managedRoot,
    sourcePath: source,
    sourceHead,
    repositoryIdentity: identity,
    barePath,
    worktreeRoot: path.join(managedRoot, "worktrees", safeName(identity)),
  };
}

async function resolveRef(managedRepository, preferredRef) {
  const preferred = String(preferredRef ?? "").trim();
  const candidates = [
    preferred,
    preferred && `refs/heads/${preferred}`,
    preferred && `refs/remotes/origin/${preferred}`,
    "refs/remotes/origin/HEAD",
    "HEAD",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = await git(["-C", managedRepository.barePath, "rev-parse", "--verify", candidate], undefined, { allowFailure: true });
    if (result.code === 0) return candidate;
  }
  managedGitError(`Could not resolve a base ref for managed source ${managedRepository.barePath}.`);
}

async function addWorktree(managedRepository, pathname, branch, baseRef) {
  if (await existingWorktree(pathname)) return;
  await mkdir(path.dirname(pathname), { recursive: true });
  await git(["-C", managedRepository.barePath, "worktree", "add", "--force", "-B", branch, pathname, baseRef]);
}

export async function createParentWorktree({ managedRepository, parentKey, parentBranch, baseRef } = {}) {
  if (!managedRepository?.barePath) managedGitError("managedRepository is required.");
  const parent = text(parentKey, "parentKey");
  const branch = text(parentBranch, "parentBranch");
  const pathname = path.join(managedRepository.worktreeRoot, parent, "parent");
  const ref = await resolveRef(managedRepository, baseRef ?? branch);
  await addWorktree(managedRepository, pathname, branch, ref);
  return { path: pathname, branch, baseSha: await gitOutput(["-C", pathname, "rev-parse", "HEAD"]) };
}

export async function createTaskWorktree({ managedRepository, parentKey, childKey, taskBranch, baseRef } = {}) {
  if (!managedRepository?.barePath) managedGitError("managedRepository is required.");
  const parent = text(parentKey, "parentKey");
  const child = text(childKey, "childKey");
  const branch = text(taskBranch, "taskBranch");
  const pathname = path.join(managedRepository.worktreeRoot, parent, "tasks", child);
  const ref = await resolveRef(managedRepository, baseRef);
  await addWorktree(managedRepository, pathname, branch, ref);
  return { path: pathname, branch, baseSha: await gitOutput(["-C", pathname, "rev-parse", "HEAD"]) };
}

export async function collectChangedPaths({ cwd, baseSha } = {}) {
  const worktree = text(cwd, "cwd");
  const base = text(baseSha, "baseSha");
  const changed = await gitOutput(["-C", worktree, "diff", "--name-only", base]);
  const untracked = await gitOutput(["-C", worktree, "ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...changed.split(/\r?\n/), ...untracked.split(/\r?\n/)].filter(Boolean))].sort();
}

function scopeContains(scope, pathname) {
  return scope.type === "file" ? scope.path === pathname : pathname === scope.path || pathname.startsWith(`${scope.path}/`);
}

export function validateChangedPaths(paths, scopes) {
  if (!Array.isArray(paths) || paths.some((pathname) => typeof pathname !== "string" || !pathname.trim())) {
    managedGitError("Changed paths must be a list of non-empty repository-relative paths.");
  }
  if (!Array.isArray(scopes) || scopes.length === 0) return { valid: true, unchecked: true, paths: [...paths] };
  const normalized = normalizeScopes(scopes);
  const outside = paths.filter((pathname) => !normalized.some((scope) => scopeContains(scope, pathname)));
  if (outside.length) managedGitError(`Task changed path(s) outside its declared scope: ${outside.join(", ")}.`);
  return { valid: true, unchecked: false, paths: [...paths] };
}

async function runShell(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runTaskVerification({ cwd, verification } = {}) {
  const worktree = text(cwd, "cwd");
  if (!Array.isArray(verification) || verification.length === 0) managedGitError("Task verification must declare command(s) or 'none'.");
  if (verification.length === 1 && String(verification[0]).trim().toLowerCase() === "none") return { skipped: true, results: [] };
  const results = [];
  for (const declaredCommand of verification) {
    const command = text(declaredCommand, "verification command");
    const result = await runShell(command, worktree);
    results.push({ command, ...result });
    if (result.code !== 0) managedGitError(`Task verification failed: ${command}. ${(result.stderr || result.stdout).trim()}`);
  }
  return { skipped: false, results };
}

export async function safeCommit({ cwd, message } = {}) {
  const worktree = text(cwd, "cwd");
  const commitMessage = text(message, "commit message");
  const status = await gitOutput(["-C", worktree, "status", "--porcelain"]);
  if (!status) return { committed: false, sha: await gitOutput(["-C", worktree, "rev-parse", "HEAD"]) };
  await git(["-C", worktree, "add", "-A"]);
  await git(["-C", worktree, "commit", "-m", commitMessage]);
  return { committed: true, sha: await gitOutput(["-C", worktree, "rev-parse", "HEAD"]) };
}

async function acquireMergeLock(parentWorktreePath) {
  const lockPath = path.join(parentWorktreePath, ".crosby-merge.lock");
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }));
    await handle.close();
    return lockPath;
  } catch (error) {
    if (error?.code === "EEXIST") managedGitError(`Integration is already running for ${parentWorktreePath}.`);
    throw error;
  }
}

export async function serializedMerge({ parentWorktreePath, taskBranch, message } = {}) {
  const parent = text(parentWorktreePath, "parentWorktreePath");
  const branch = text(taskBranch, "taskBranch");
  const lockPath = await acquireMergeLock(parent);
  try {
    const ancestry = await git(["-C", parent, "merge-base", "--is-ancestor", branch, "HEAD"], undefined, { allowFailure: true });
    if (ancestry.code === 0) {
      return { merged: false, alreadyMerged: true, sha: await gitOutput(["-C", parent, "rev-parse", "HEAD"]) };
    }
    const result = await git(["-C", parent, "merge", "--no-ff", "--no-commit", branch], undefined, { allowFailure: true });
    if (result.code !== 0) {
      await git(["-C", parent, "merge", "--abort"], undefined, { allowFailure: true });
      managedGitError(`Merge of ${branch} into the parent integration worktree conflicted: ${(result.stderr || result.stdout).trim()}`);
    }
    await git(["-C", parent, "commit", "-m", message ?? `Merge ${branch} into Crosby parent`]);
    return { merged: true, sha: await gitOutput(["-C", parent, "rev-parse", "HEAD"]) };
  } finally {
    await rm(lockPath, { force: true });
  }
}

export function retainTaskFailure({ task, reason } = {}) {
  if (!task?.path || !task?.branch) managedGitError("A retained task worktree and branch are required.");
  return {
    outcome: "review-required",
    taskWorktreePath: task.path,
    taskBranch: task.branch,
    recoveryNotes: [text(reason, "failure reason")],
  };
}
