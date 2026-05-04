# Crosby

Crosby is the Linear execution orchestrator for this workflow.

## Quick start

### Run one parent manually

```text
/crosby COA-129
```

Use this when you want to kick off the next runnable child under one parent immediately.

### Run the overnight/background watcher

```text
/crosby --watch
```

Use this when you want Crosby to poll for parent issues in `Execute` and work eligible child issues automatically.

### Stop the watcher

- stop the current Pi run
- close the terminal/session running it
- or press `Ctrl+C`

### Core rule

- parent in `Execute` = active workflow
- child in `Ready to Build` = runnable work
- one parent issue = one feature branch


## What it does

Crosby supports two modes:

- **Manual mode**: run one parent now
- **Watch mode**: poll Linear and automatically process active parents

It uses:

- **Pi build worker** for child implementation
  - default model: `openai/gpt-5.5`
- **Claude review worker** for final parent review
  - default model: `claude-sonnet-4-6`
  - default effort: `medium`

## Commands

### Manual run

```text
/crosby COA-129
```

Use this when you want to manually trigger execution for a single parent issue.

What happens:

1. Crosby loads the parent
2. Reads the child issues
3. Picks the next unblocked child in `Ready to Build`
4. Ensures the repo is on the parent feature branch
   - checks out the existing branch if present
   - creates it if missing
5. Moves that child to `Build`
6. Runs the Pi worker
7. Moves the child to:
   - `Done` if complete
   - `In Review` if human review/action is needed
8. Posts a progress comment to the parent
9. If all children are `Done`, Crosby finalizes the parent and moves it to `In Review`

### Watch mode

```text
/crosby --watch
```

Use this when you want Crosby to keep polling in the background.

Current behavior:

- polls every **60 seconds**
- looks for **parent issues in `Execute`**
- reads the children under those parents
- picks the next unblocked child in `Ready to Build`
- ensures the repo is on the parent feature branch
- moves that child to `Build`
- runs the Pi worker
- posts progress back to the parent
- finalizes the parent when all child issues are complete

## How to stop watch mode

There is no separate `/crosby --stop` command.

To stop watch mode:

- stop the current Pi run
- or close the terminal/session running it
- or use `Ctrl+C` if it is running in a terminal

If watch mode is off, nothing runs automatically.

## Workflow states

### Parent issue states

- `Ready to Build`
  - inactive
  - watcher ignores it
- `Execute`
  - active
  - watcher will inspect this parent and try to run child work
- `In Review`
  - all child work is complete and parent has been finalized
- `Done`
  - fully finished

### Child issue states

- `Backlog`
  - typically used for `HITL` child issues
  - not auto-run
- `Ready to Build`
  - runnable state for buildable child issues
- `Build`
  - currently being worked by Crosby
- `In Review`
  - implementation finished but human review/action is required
- `Done`
  - complete

## Intended issue creation defaults

- `AFK` child issues -> `Ready to Build`
- `HITL` child issues -> `Backlog`

## How the workflow is intended to work

### Manual path

1. Create child issues
2. AFK children start in `Ready to Build`
3. Run:

```text
/crosby COA-129
```

4. Crosby works the next runnable child under that parent

### Watch path

1. Create child issues
2. AFK children start in `Ready to Build`
3. Move the **parent** issue to `Execute`
4. Start watch mode:

```text
/crosby --watch
```

5. Crosby finds parents in `Execute`
6. It works child issues in `Ready to Build`, one at a time

## Important rules

- Watch mode is driven by **parent issues in `Execute`**
- Child issues do **not** need to be moved to `Execute`
- Child issues must be in **`Ready to Build`** to be auto-run
- One parent issue = one feature branch
- Before child execution, Crosby resolves the parent `branchName`, checks out that branch, or creates it if needed
- If the resolved project folder is not a git repo, Crosby stops with a descriptive error
- If Crosby would need to switch branches and the repo has uncommitted changes, it stops with a descriptive error instead of risking work on the wrong branch
- Blocked children are skipped until blockers are `Done`
- If a child is already in `Build`, Crosby will not start another child for that parent

## Review/finalization behavior

When all child issues are `Done`, Crosby:

1. reads `implementation_summary.md`
2. loads the GitHub PR
3. updates the PR description
4. runs Claude review
5. posts the review result to the PR
6. posts the final summary to the parent Linear issue
7. moves the parent to `In Review`

## Config overrides

Optional environment variables:

- `CROSBY_PI_MODEL`
- `CROSBY_CLAUDE_MODEL`
- `CROSBY_CLAUDE_EFFORT`

Defaults:

- `CROSBY_PI_MODEL=openai/gpt-5.5`
- `CROSBY_CLAUDE_MODEL=claude-sonnet-4-6`
- `CROSBY_CLAUDE_EFFORT=medium`

## Files

- `index.ts` - Pi extension entrypoint
- `lib.mjs` - core Crosby logic
- `lib-v2.mjs` - active imported library used by the extension
