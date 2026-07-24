# Research: COA-360 Crosby Herdr-supervised execution

## Current Crosby baseline

The current extension launches workers through Pi print mode (`pi -p --no-session`) and parses JSON written to standard output. Its queue execution is synchronous: `runQueueExecution()` loops through child issues and `runWatchMode()` processes one eligible child per poll. It protects a shared parent checkout by refusing a second active child, which is incompatible with visible parallel work.

The extension already has reusable queue classification, Linear state transitions, parent/child reporting, branch preparation, worker-result parsing, explicit push/review commands, and test coverage in `lib-v2.test.mjs`. Those behaviors should be retained behind new scheduler and integration boundaries rather than reimplemented in command handlers.

## Pi capabilities validated

Pi extensions support the pieces required for an interactive supervisor and worker protocol:

- extension commands and custom tools;
- user-message injection with streaming-safe steer/follow-up delivery;
- persistent session entries, custom rendering, and session lifecycle events;
- a shared extension event bus;
- structured terminating tool results; and
- confirmation dialogs and status/widget UI.

Pi session entries are intentionally insufficient as the sole scheduler database: they are per-session trees, while task recovery must work from a replacement supervisor session and across multiple active parents. The durable Crosby registry therefore belongs outside session storage; session entries remain useful as local transcript/audit hints.

## Herdr capabilities validated

Herdr provides command/API operations to create tabs with a requested working directory and label, start an interactive Pi agent in a pane, send prompts, wait for agent lifecycle states, inspect live agent output, and obtain an API snapshot. Its existing Pi integration reports `working`, `idle`, and `blocked` state. A Crosby worker can emit the existing blocked event when it needs human input so that its tab is visibly flagged in the Agents column.

Herdr agent lifecycle state is operational telemetry, not task completion. A worker must submit an explicit structured Crosby report before the scheduler considers it complete or blocked.

## Architecture decision: managed Git source

A `git worktree` attached to the operator’s normal clone alone does not fully guarantee that the normal checkout is unaffected: the parent feature branch may already be checked out there, and updating that ref can make the operator’s checkout stale or create branch ownership conflicts.

**Chosen approach**: Crosby maintains a managed bare clone/cache per repository identity under its application data root. It creates the parent integration worktree and each child task worktree from that managed source. The normal checkout supplies repository identity/config discovery only and is never checked out, reset, merged, or written by Crosby. Parent changes become visible to the normal clone through the ordinary fetch/push workflow.

## Architecture decision: task metadata

New Linear child descriptions will contain an explicit Crosby execution block with:

- `Parallel: allowed|sequential`;
- `File scope`: repository-relative exact file paths or directory paths; and
- `Verification`: explicit minimum commands or `none`.

The scheduler treats missing or invalid metadata as legacy sequential execution. It does not infer safe parallelism from a title, model prediction, current diff, or test outcome. The `to-issues` skill becomes the canonical publisher of this metadata, and `tasks` aligns `[P]` notation with it.

## Architecture decision: integration ordering

Workers may finish in any order. Their task branches are nevertheless merged one at a time into the managed parent integration worktree. Before merge, Crosby compares the full task-branch change set with the persisted task scope and runs the task’s minimum verification. A merge conflict, out-of-scope path, or failed verification keeps the branch/worktree intact and requires human review.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Herdr CLI/API response changes or partial failure | Put all CLI calls behind a validated adapter; fail launch closed with a launcher-tab error. |
| Restart duplicates worker | Persist an atomic registry and reconcile Herdr, Git, and Linear before dispatch. |
| User steers a worker outside scope | Validate full changed-path range at integration; never grant a direct-steering bypass. |
| Parent comments become unreadable | Put authoritative detail on child issues and link-only parent updates. |
| A worker becomes idle without being done | Require a structured report tool; treat idle as telemetry only. |
| Managed clone diverges from source | Record source remote/base SHA and fetch/reconcile before parent/task setup. |
| Existing tasks lack metadata | Preserve sequential legacy path with a visible warning. |
