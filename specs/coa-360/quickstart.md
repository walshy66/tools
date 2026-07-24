# Quickstart: Crosby Herdr-supervised execution

> Planned operator flow; no implementation exists yet.

## Prerequisites

1. Start Crosby from a Herdr-hosted Pi supervisor tab.
2. Ensure the target repository has valid Crosby execution configuration with its final integration commands.
3. Place the parent Linear issue in `Execute`.
4. For a task to run concurrently, give it explicit parallel opt-in, a non-overlapping file/folder scope, and its minimum verification declaration.

## Start and observe

1. Run `/crosby COA-360` in the trigger tab, or start the watcher.
2. Crosby claims eligible children, creates task tabs named `COA-…`, and displays the task tree in the supervisor.
3. Open a task tab for full agent/transcript detail.
4. Ask the supervisor for task-key-targeted status or route an instruction through it.

## Human decision flow

1. A worker needing input appears blocked in Herdr and its child moves to `In Review`.
2. Review its task tab and child issue report.
3. Answer through the supervisor; confirm the outgoing instruction.
4. Crosby returns the child to `Build` and resumes it.

## Completion and cleanup

1. A worker submits its structured completion report.
2. Crosby validates the scope, runs minimum task verification, and serially merges its task branch into the parent feature branch.
3. Crosby posts full evidence to the child issue and a concise completion/link note to the parent.
4. After every child is integrated, Crosby runs configured parent integration checks before moving the parent to `In Review`.
5. Finished tabs and worktrees remain available until an operator explicitly requests confirmed cleanup.

## Recovery

If the supervisor or Herdr restarts, start/reopen Crosby from a Herdr supervisor tab. Crosby reconciles the persisted registry with Herdr, Linear, and Git before launching more work. If Herdr cannot create a worker tab, Crosby reports the failure and does not fall back to headless execution.
