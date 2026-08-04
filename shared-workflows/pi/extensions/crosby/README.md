# Crosby

Crosby runs one sequential, Herdr-visible worker at a time from a local build folder. Each task gets an isolated Git worktree; accepted commits integrate into one parent branch. Crosby never creates a PR automatically.

## Build layout

Create a numbered build folder containing `tasks.md`:

```text
specs/001-example/tasks.md
```

The task list declares the build ID, parent branch, stable task IDs, order, outcome, acceptance criteria, file scope, verification, and guardrails. An optional `### Instructions` section may add worker-specific direction; when omitted, Crosby uses the task outcome as its concise instruction. `Execution mode` defaults to `AFK`; a `HITL` task is a hard human gate and Crosby stops before model selection or worker launch. Directory scope may use a trailing `/` or the explicit recursive form `/**`; other globs remain invalid. Generate the build with the shared `to-issues` workflow. Markdown is input; durable execution state lives in the Crosby registry.

## Run

Run Crosby from a Pi session inside Herdr:

```text
/crosby run specs/001-example
/crosby resume specs/001-example
/crosby status specs/001-example
```

`run` loads the build, creates or adopts the Herdr supervisor, creates the managed parent worktree, and launches the first task. `resume` reconciles durable state, integrates a completed report from its persisted task worktree without relaunching, and skips already integrated tasks. `status` prints every authored task with completed, running, awaiting-integration, pending, or human-gate state without launching a worker. Crosby also appends this full progress list as a durable parent-transcript entry after each integration and alongside any build error. `tasks.md` remains immutable execution input; it is never dirtied with runtime checkboxes.

The parent tab remains interactive. The active task runs in its own visible Herdr tab and worktree, without stealing focus. Repository identity scopes managed worktree paths, and worker agent names are scoped to the build registry, so repeated build and task IDs from separate repositories cannot collide. Only one worker may own the queue gate at a time, and tasks advance strictly in authored order. Optional lifecycle-notification failures are retained as worker warnings and never reclassify a successfully launched worker as failed.

## Worker model selection

Before launching each new task, the parent Pi model assesses the task contract and chooses from a focused pool of authenticated, reasoning-capable models on the parent model's provider. For versioned OpenAI Codex models, the pool stays within the parent's model family (for example, the available GPT-5.6 variants) to avoid routing to older or account-incompatible entries. Crosby validates and persists the selection, then starts Pi through the interactive shell with validated native arguments:

```text
pi --approve --model <selected-provider/model> --thinking medium
```

Crosby dispatches the task prompt only after Herdr detects the configured worker. This prevents model or thinking configuration text from becoming an accidental model turn or delaying the real task contract. The shell-native launch avoids the PowerShell `Start-Process` shim failure while its allowlist rejects unsafe argument values. A resumed worker reuses its persisted selection rather than reassessing. Missing parent-model context, authentication failure, an empty candidate pool, or an out-of-pool answer fails closed before worker launch. The operator sees the selected model and thinking level in the parent tab.

## Worker reports

A worker must finish with exactly one structured report using `crosby_worker_report`:

- `complete` — includes changed paths, commit, verification, and risks.
- `blocked` — includes required human action and recovery notes.
- `failed` — includes summary and recovery notes.
- `cancelled` — includes summary and recovery notes.

Herdr `idle`, `done`, process exit, or terminal text never counts as completion. Any invalid or missing report stops the queue. When a resumed worker replaces a blocked report with a terminal non-blocked report, Crosby clears the visible Herdr blocked marker.

## Observe and control

Worker guidance and lifecycle control target the worker tab directly:

- Ask the worker for an update or provide guidance.
- Pause and resume without releasing the queue gate.
- Stop only with explicit confirmation; the worker tab may close but its worktree and branch remain.
- Clean up retained evidence only with explicit confirmation after inspection.

The durable registry is under `~/.pi/crosby/registries/` by default. It records build identity, Herdr space, supervisor and worker IDs, queue state, reports, worktrees, and recovery evidence. A resumed build rebinds stale supervisor metadata to the parent pane currently consuming reports.

## Integration and recovery

Before integration Crosby:

1. Collects changed paths and validates them against the task scope.
2. Runs every declared verification command.
3. Commits task evidence if needed.
4. Merges serially into the parent branch.

Scope violations, failed verification, merge conflicts, blocked reports, failed reports, and cancelled reports stop the queue. Worker prompts repeat the complete allowed scope and require a blocked report rather than an out-of-scope edit. New managed parents are based on the operator checkout's exact committed `HEAD`, not a stale cached bare-repository `HEAD`. If an unstarted retained parent predates that source commit, Crosby fails closed and requires explicit cleanup rather than silently resetting evidence. Task worktrees and branches remain available for inspection. A worker-launch failure also retains its newly created Herdr tab so the operator can inspect the terminal evidence before explicit cleanup. Crosby does not auto-resolve conflicts, delete evidence, push, or create a PR.

After a restart, Crosby adopts recorded Herdr workers when they are inspectable and never launches a duplicate for an uncertain active task. Herdr unavailability fails closed.

## Safety rules

- Run only from a Herdr-managed Pi pane.
- Keep the normal checkout separate from managed parent/task worktrees.
- Do not edit `tasks.md` as runtime state.
- Review the final parent branch and run the shared `code-reviewer` workflow before creating the single PR.
- Use explicit Git/PR commands only after operator review and confirmation.
