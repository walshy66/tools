import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ManagedGitError,
  collectChangedPaths,
  createManagedRepository,
  createParentWorktree,
  createTaskWorktree,
  retainTaskFailure,
  runTaskVerification,
  safeCommit,
  serializedMerge,
  validateChangedPaths,
} from "./managed-git.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function setupRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "crosby-git-"));
  const operatorCheckout = path.join(root, "operator");
  await git(root, "init", "operator");
  await git(operatorCheckout, "config", "user.name", "Crosby Test");
  await git(operatorCheckout, "config", "user.email", "crosby@example.test");
  await writeFile(path.join(operatorCheckout, "in-scope.txt"), "base\n");
  await git(operatorCheckout, "add", ".");
  await git(operatorCheckout, "commit", "-m", "base");
  return { root, operatorCheckout };
}

test("managed parent and task worktrees leave the operator checkout untouched", async () => {
  const { root, operatorCheckout } = await setupRepository();
  const managed = await createManagedRepository({ root: path.join(root, "managed"), sourcePath: operatorCheckout });
  const parent = await createParentWorktree({
    managedRepository: managed,
    parentKey: "COA-360",
    parentBranch: "crosby/parent",
  });
  const task = await createTaskWorktree({
    managedRepository: managed,
    parentKey: "COA-360",
    childKey: "COA-363",
    taskBranch: "crosby/task",
    baseRef: parent.branch,
  });

  await writeFile(path.join(task.path, "in-scope.txt"), "task change\n");
  assert.equal((await git(operatorCheckout, "status", "--short")).stdout, "");
  assert.notEqual(task.path, operatorCheckout);
  assert.notEqual(parent.path, operatorCheckout);
});

test("collects all task changes and rejects an out-of-scope path", async () => {
  const { root, operatorCheckout } = await setupRepository();
  const managed = await createManagedRepository({ root: path.join(root, "managed"), sourcePath: operatorCheckout });
  const parent = await createParentWorktree({ managedRepository: managed, parentKey: "COA-360", parentBranch: "crosby/parent" });
  const task = await createTaskWorktree({ managedRepository: managed, parentKey: "COA-360", childKey: "COA-363", taskBranch: "crosby/task", baseRef: parent.branch });
  await writeFile(path.join(task.path, "outside.txt"), "not allowed\n");

  const changedPaths = await collectChangedPaths({ cwd: task.path, baseSha: task.baseSha });
  assert.deepEqual(changedPaths, ["outside.txt"]);
  assert.throws(() => validateChangedPaths(changedPaths, [{ path: "in-scope.txt", type: "file" }]), ManagedGitError);
  assert.deepEqual(validateChangedPaths(changedPaths, []), { valid: true, unchecked: true, paths: changedPaths });
});

test("verification none skips only focused verification and safe commit retains evidence", async () => {
  const { root, operatorCheckout } = await setupRepository();
  const managed = await createManagedRepository({ root: path.join(root, "managed"), sourcePath: operatorCheckout });
  const task = await createTaskWorktree({ managedRepository: managed, parentKey: "COA-360", childKey: "COA-363", taskBranch: "crosby/task", baseRef: "HEAD" });
  await writeFile(path.join(task.path, "in-scope.txt"), "changed\n");

  assert.deepEqual(await runTaskVerification({ cwd: task.path, verification: ["none"] }), { skipped: true, results: [] });
  await assert.rejects(() => runTaskVerification({ cwd: task.path, verification: ["node -e \"process.exit(2)\""] }), ManagedGitError);
  const commit = await safeCommit({ cwd: task.path, message: "feat: task evidence" });
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.equal((await git(operatorCheckout, "status", "--short")).stdout, "");
});

test("a merge conflict aborts parent integration and retains task evidence", async () => {
  const { root, operatorCheckout } = await setupRepository();
  const managed = await createManagedRepository({ root: path.join(root, "managed"), sourcePath: operatorCheckout });
  const parent = await createParentWorktree({ managedRepository: managed, parentKey: "COA-360", parentBranch: "crosby/parent" });
  const task = await createTaskWorktree({ managedRepository: managed, parentKey: "COA-360", childKey: "COA-363", taskBranch: "crosby/task", baseRef: parent.branch });
  await writeFile(path.join(task.path, "in-scope.txt"), "task\n");
  await safeCommit({ cwd: task.path, message: "feat: task" });
  await writeFile(path.join(parent.path, "in-scope.txt"), "parent\n");
  await safeCommit({ cwd: parent.path, message: "feat: parent" });

  await assert.rejects(() => serializedMerge({ parentWorktreePath: parent.path, taskBranch: task.branch }), ManagedGitError);
  assert.equal((await git(parent.path, "status", "--short")).stdout, "");
  assert.match((await git(task.path, "log", "-1", "--format=%s")).stdout, /feat: task/);
  assert.deepEqual(retainTaskFailure({ task, reason: "merge conflict" }), {
    outcome: "review-required",
    taskWorktreePath: task.path,
    taskBranch: task.branch,
    recoveryNotes: ["merge conflict"],
  });
});
