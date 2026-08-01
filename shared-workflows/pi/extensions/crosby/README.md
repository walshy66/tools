# Crosby

Crosby runs one sequential, Herdr-visible worker at a time from a local build folder. Each task gets an isolated Git worktree; accepted commits integrate into one parent branch. Crosby never creates a PR automatically.

## Build layout

Create a numbered build folder containing `tasks.md`:

```text
specs/001-example/tasks.md
```

The task list declares the build ID, parent branch, stable task IDs, order, acceptance criteria, file scope, verification, instructions, and guardrails. Generate it with the shared `to-issues` workflow. Markdown is input; durable execution state lives in the Crosby registry.

## Run

Run Crosby from a Pi session inside Herdr:

```text
/crosby run specs/001-example
/crosby resume specs/001-example
/crosby status specs/001-example
```

`run` loads the build, creates or adopts the Herdr supervisor, creates the managed parent worktree, and launches the first task. `resume` reconciles durable state, integrates a completed report from its persisted task worktree without relaunching, and skips already integrated tasks. `status` reports the durable queue state without launching a worker.

The parent tab remains interactive. The active task runs in its own visible Herdr tab and worktree, without stealing focus. Only one worker may own the queue gate at a time, and tasks advance strictly in authored order. Optional lifecycle-notification failures are retained as worker warnings and never reclassify a successfully launched worker as failed.

## Worker reports

A worker must finish with exactly one structured report using `crosby_worker_report`:

- `complete` — includes changed paths, commit, verification, and risks.
- `blocked` — includes required human action and recovery notes.
- `failed` — includes summary and recovery notes.
- `cancelled` — includes summary and recovery notes.

Herdr `idle`, `done`, process exit, or terminal text never counts as completion. Any invalid or missing report stops the queue.

## Observe and control

Worker guidance and lifecycle control target the worker tab directly:

- Ask the worker for an update or provide guidance.
- Pause and resume without releasing the queue gate.
- Stop only with explicit confirmation; the worker tab may close but its worktree and branch remain.
- Clean up retained evidence only with explicit confirmation after inspection.

The durable registry is under `~/.pi/crosby/registries/` by default. It records build identity, Herdr space, supervisor and worker IDs, queue state, reports, worktrees, and recovery evidence.

## Integration and recovery

Before integration Crosby:

1. Collects changed paths and validates them against the task scope.
2. Runs every declared verification command.
3. Commits task evidence if needed.
4. Merges serially into the parent branch.

Scope violations, failed verification, merge conflicts, blocked reports, failed reports, and cancelled reports stop the queue. Task worktrees and branches remain available for inspection. A worker-launch failure also retains its newly created Herdr tab so the operator can inspect the terminal evidence before explicit cleanup. Crosby does not auto-resolve conflicts, delete evidence, push, or create a PR.

After a restart, Crosby adopts recorded Herdr workers when they are inspectable and never launches a duplicate for an uncertain active task. Herdr unavailability fails closed.

## Safety rules

- Run only from a Herdr-managed Pi pane.
- Keep the normal checkout separate from managed parent/task worktrees.
- Do not edit `tasks.md` as runtime state.
- Review the final parent branch and run the shared `code-reviewer` workflow before creating the single PR.
- Use explicit Git/PR commands only after operator review and confirmation.
