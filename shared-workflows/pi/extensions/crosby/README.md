# Crosby

Crosby executes Linear child tasks in isolated, visible Herdr/Pi workers. It uses one managed parent worktree per Linear parent and one managed task worktree per child, then serially integrates verified task branches.

## Configure

1. Install the extension and make `linear`, `git`, and `herdr` available to Pi. Run `/crosby` only from a Pi session inside Herdr; Crosby uses that caller's workspace and never the mutable UI-focused workspace.
2. Add a folder label to the parent issue that resolves to the local repository (for example `tools-coa-360`). Crosby searches `C:\Users\camer\Documents\<label>` and `C:\Users\camer\Documents\projects\<label>`.
3. Give the parent a Linear `branchName` and create AFK child tasks in `Ready to Build`.
4. Add exactly one work-type label to every execution task (`wt:process-automation` for Crosby work).
5. Optionally configure Claude PR review:
   - `CROSBY_CLAUDE_MODEL` (default `claude-sonnet-4-6`)
   - `CROSBY_CLAUDE_EFFORT` (default `medium`)

Pi workers inherit normal Pi model/session selection. The optional variables apply only to the explicit Claude PR-review worker.

## Task metadata

A child task must declare its execution contract in its Linear description:

```md
## Crosby execution

- Parallel: sequential
- File scope:
  - `shared-workflows/pi/extensions/crosby/index.ts`
- Verification:
  - `node --test shared-workflows/pi/extensions/crosby/scheduler.test.mjs`
```

Use `Parallel: allowed` only when file scopes are disjoint. The scheduler rejects invalid contracts, unresolved blockers, overlapping scopes, and missing verification before a task is selected. Integration validates changed paths and runs the declared verification before committing and merging.

## Execute a queue

```text
/crosby COA-360
/crosby --watch
/crosby push COA-360
/crosby review COA-360
```

- `/crosby COA-360` selects the next unblocked `Ready to Build` child under that parent.
- `/crosby --watch` polls parents in `Execute` every 60 seconds.
- `/crosby push COA-360` explicitly pushes the parent branch and creates or updates its PR.
- `/crosby review COA-360` explicitly runs the Claude PR review.

Crosby reconciles persisted reports, then dispatches up to two eligible workers globally. Tasks in the same repository run together only when both declare `Parallel: allowed` with disjoint scopes. Each selected child moves to `Build`, receives a visible Herdr tab and Pi worker, and records its task worktree, branch, tab, pane, agent, and contract in the local registry. The worker finishes through the `crosby_worker_report` tool, which validates and persists its completion or block report; a blocked report also marks the Herdr agent blocked. Reported branches are integrated serially. A successful integration moves the child to `Done`; a recoverable integration or worker problem moves it to `In Review` with retained evidence. When every child is `Done`, it runs final integration commands, posts the consolidated parent report, and moves the parent to `In Review`.

## Observe and control workers

Crosby registers task-keyed tools for both explicit calls and conversational operator requests. Every operation requires both the owning parent key and the task key, so it cannot accidentally target another queue:

- `crosby_task_status(parentKey, taskKey)` — compact lifecycle, attempts, agent state, and retained tab/worktree/branch.
- `crosby_task_ask(parentKey, taskKey, message)` — send an operator message to the worker.
- `crosby_task_pause(parentKey, taskKey)` — instruct the worker to pause and retain evidence.
- `crosby_task_resume(parentKey, taskKey)` — resume a paused worker.
- `crosby_task_stop(parentKey, taskKey)` — close the worker tab while retaining the task worktree and branch.
- `crosby_task_cleanup(parentKey, taskKey)` — remove the retained worker tab and managed task worktree.

The same supervisor operation backs explicit tool use and conversational routing. Status deliberately reports compact state; full durable task records remain in the local Crosby registry at `~/.pi/crosby/registries/`.

Stop and cleanup first show their exact affected task/tab/worktree and require a UI confirmation. Cancelling leaves everything unchanged. Cleanup is the only action that removes a retained task worktree. It is intentionally destructive; inspect, commit, or copy any needed evidence before confirming it.

## Lifecycle and recovery

1. **launching/running**: a visible Herdr worker owns the task worktree.
2. **paused**: the worker was asked to stop changing files until `resume`.
3. **stopped**: its tab is closed, but its worktree and branch remain for inspection or recovery.
4. **review-required**: automatic recovery or integration could not safely proceed; inspect the retained evidence and resolve the Linear child manually.
5. **cleaned**: an operator explicitly confirmed removal of the retained tab/worktree.

After a Crosby restart, it reconciles an existing recorded Herdr agent instead of starting a duplicate. If that agent is unavailable, it makes at most one automatic same-worktree recovery. A second recovery failure is retained for review rather than retried indefinitely.

For a blocked, failed, or invalid worker report:

1. Run `crosby_task_status` for the parent and task keys.
2. Inspect the visible Herdr transcript, retained tab, worktree, branch, and the child’s detailed Linear comment.
3. Use `ask`, `pause`, or `resume` when the worker can continue safely.
4. Otherwise resolve the issue manually, then move it to the appropriate Linear state. Use `cleanup` only after preserving any required evidence.

## Retention and cleanup

Completed, stopped, and review-required task tabs/worktrees are retained by default. Normal completion does **not** automatically close a task tab or delete a worktree. This makes integration evidence and recovery inspectable. Explicit cleanup closes a remaining tab (if any) and uses Git worktree removal for the task path; it does not silently clean sibling tasks.

## Migration from earlier Crosby behavior

Earlier Crosby runs executed workers directly from the parent checkout and offered no task-keyed supervisor controls. Migrate by:

1. Adding task contracts and the work-type label to current child issues.
2. Starting or resuming work through `/crosby <PARENT-KEY>` so Crosby creates managed worktrees and a registry record.
3. Using the supervisor tools for status and recovery instead of closing terminals or deleting worktrees manually.
4. Keeping existing parent `Build`/`Building` states as valid resume states; do not reset them merely to restart Crosby.
5. Cleaning up old manual worktrees only after confirming their contents are integrated or no longer needed.

## Safety rules

- Parents in `Execute` are watched; children must be `Ready to Build` to be selected.
- Blocked children are skipped until every blocker is `Done`.
- One parent has one feature branch; task branches are integrated serially.
- Crosby fails closed if it cannot resolve a repository folder, branch, task contract, worker report, or required verification.
- Push and PR review remain explicit operations and require a clean working tree.
