# Spec: COA-360 Crosby Herdr-supervised execution

**Status**: READY_FOR_PLAN  
**Source**: https://linear.app/coachcw/issue/COA-360/crosby-herdr-supervised-execution  
**Priority**: High  
**Work Type**: process-automation

## Summary

Crosby must replace opaque headless child execution with visible, interactive Herdr-managed workers. The tab that starts Crosby is the durable supervisor: it presents a live task tree, accepts explicit and conversational control, and manages safe task integration. Each active child task has a Herdr tab named with its Linear identifier.

The system may execute up to two tasks globally in parallel, but only when both tasks explicitly allow parallel execution, have no unresolved blockers, and own non-overlapping declared repository paths. All task work remains isolated until Crosby validates and integrates it into the parent feature branch. Crosby never merges task work directly into `main`.

## User Scenarios & Testing

### User Story 1 — Observe and supervise active work (Priority: P1)

As an operator, I want every Crosby task to appear in its own Herdr tab and in the supervisor task tree so I can see what it is doing instead of relying on blind background execution.

**Independent Test**: Start a runnable parent with two eligible children and verify that each launched child has a tab named by its issue key, an interactive Pi worker, and an accurate supervisor-tree entry.

**Acceptance Scenarios**:
1. **Given** Crosby starts a child task, **When** the worker is ready, **Then** Herdr shows an interactive worker tab named with that child’s Linear key.
2. **Given** a worker is running, idle, blocked, or complete, **When** the supervisor renders its task tree, **Then** it displays the matching observable lifecycle state.
3. **Given** an operator needs detailed activity, **When** they open the task tab, **Then** they can inspect the worker’s live Pi transcript and terminal output.
4. **Given** Herdr cannot create or attach the task worker, **When** Crosby attempts launch, **Then** it does not run headlessly and reports the failure in the launcher tab.

### User Story 2 — Control work from the supervisor (Priority: P1)

As an operator, I want to ask for status, route instructions, pause, resume, stop, and clean up tasks from the trigger tab without memorizing a command-only interface.

**Independent Test**: Use both explicit supervisor controls and conversational requests to inspect and operate a known task; verify both reach the same task-key-targeted operation.

**Acceptance Scenarios**:
1. **Given** an active task key, **When** the operator requests its status or asks it a question through the supervisor, **Then** the request is routed to that exact task worker.
2. **Given** a worker needs a human decision, **When** it reports the blocker, **Then** its Herdr agent state is blocked, its child issue is `In Review`, and unrelated eligible tasks may continue.
3. **Given** the operator supplies an answer, **When** they confirm the outgoing instruction, **Then** Crosby routes it to the task and returns the child to `Build` when work resumes.
4. **Given** an operator requests a destructive action, **When** the action would stop work or remove a worktree, **Then** Crosby identifies the affected task or parent and requires confirmation.

### User Story 3 — Execute independent tasks safely in parallel (Priority: P1)

As an operator, I want Crosby to use two worker slots when tasks cannot overwrite one another, while preserving deterministic behavior and safe integration.

**Independent Test**: Create two unblocked children that explicitly allow parallelism and declare separate file/folder scopes; verify both start in isolated workspaces, then integrate without modifying the normal checkout.

**Acceptance Scenarios**:
1. **Given** two eligible tasks with disjoint declared scopes and available capacity, **When** the scheduler evaluates them, **Then** it may launch both and never exceeds two workers globally.
2. **Given** scopes overlap, either task lacks parallel opt-in, or a blocker remains unresolved, **When** the scheduler evaluates them, **Then** it does not run those tasks together.
3. **Given** a task has no new execution metadata, **When** Crosby encounters it, **Then** it remains compatible with the legacy workflow but is scheduled sequentially only.
4. **Given** an operator has a normal project checkout open, **When** Crosby executes and integrates tasks, **Then** Crosby does not modify that checkout.

### User Story 4 — Validate and integrate task work (Priority: P1)

As an operator, I want a child to become `Done` only after its isolated changes have been validated and merged into its parent feature branch.

**Independent Test**: Complete a worker task that changes only its declared scope and passes its focused verification; verify it is merged into the parent branch before Linear is marked `Done`.

**Acceptance Scenarios**:
1. **Given** a worker reports completion, **When** its changed paths match its declared scope and required focused verification passes, **Then** Crosby merges its task branch into the parent feature branch serially before marking the child `Done`.
2. **Given** a worker changes a path outside its declared scope, has a merge conflict, or fails required verification, **When** Crosby evaluates completion, **Then** it does not merge the task, moves the child to `In Review`, and preserves the task tab and worktree.
3. **Given** all children have merged successfully, **When** the parent’s configured integration verification passes, **Then** Crosby moves the parent from `Execute` to `In Review`.
4. **Given** parent integration verification fails, **When** all child tasks have otherwise completed, **Then** the parent remains active and is flagged for human action rather than presented for review.

### User Story 5 — Preserve durable state and useful Linear history (Priority: P2)

As an operator, I want work to recover cleanly across supervisor/Herdr restarts and want Linear comments to stay concise while retaining task-level evidence.

**Independent Test**: Start a worker, restart or replace the supervisor, and verify the new supervisor adopts the existing worker without launching a duplicate. Complete a task and inspect child and parent comments.

**Acceptance Scenarios**:
1. **Given** the supervisor or Herdr restarts, **When** Crosby is started again, **Then** it reconciles persisted task records with Herdr, Git, and Linear before scheduling new work.
2. **Given** a worker completes or blocks, **When** Crosby records the outcome, **Then** the child issue receives the detailed report: summary, changed paths, commit information, verification, scope result, and follow-up/risk information.
3. **Given** a child completes, **When** the parent is updated, **Then** its comment is a concise completion/link entry rather than a duplicated technical report.
4. **Given** all children complete, **When** the parent finalizes, **Then** the parent receives a concise status-and-links summary rather than an aggregated duplicate of child reports.

### User Story 6 — Author tasks that Crosby can schedule safely (Priority: P2)

As a workflow author, I want issue-generation guidance to produce the metadata that Crosby needs without forcing unnecessary verification.

**Independent Test**: Generate a new executable issue and verify it includes a path scope, explicit parallel eligibility, and either focused verification commands or an explicit `none` declaration.

**Acceptance Scenarios**:
1. **Given** a new executable task is created through the shared workflow, **When** it is published, **Then** it declares allowed repository files/folders, parallel eligibility, dependencies, and minimum verification.
2. **Given** a copy-only task, **When** it needs no focused check, **Then** it may explicitly declare verification as `none`; workers may still run additional checks when warranted.
3. **Given** a task declares a scope, **When** Crosby parses it, **Then** the scope uses only repository-relative exact files or whole folders and excludes ambiguous whole-repository declarations.

## Edge Cases

- Two supervisors attempt to claim the same child; only one may retain the claim.
- A task is claimed in Linear but Herdr launch fails; Crosby restores the child to a runnable state and reports the failure.
- A worker process crashes or becomes unavailable; Crosby may attempt one recorded recovery, then requires review if recovery fails.
- A registry record, Herdr agent, Linear state, Git worktree, or branch is stale or missing after restart.
- Workers finish out of order while their merges must remain serialized.
- A direct operator instruction causes an out-of-scope edit.
- A task is `idle` in Herdr but has not submitted a structured completion or block report.
- A parent has missing/invalid execution configuration.
- A parent is active in `Execute` while no task can be scheduled because capacity, dependencies, scopes, or human review prevent it.
- A completed task is retained for inspection and later explicitly cleaned up.

## Requirements

### Functional Requirements

- FR-001: Crosby MUST create one visible Herdr tab and interactive Pi worker per launched child task.
- FR-002: Each worker tab MUST use the child Linear identifier as its label.
- FR-003: Crosby MUST maintain a supervisor task tree keyed by child identifier and expose task lifecycle, worktree, scope, and integration status.
- FR-004: The supervisor MUST support explicit task-key operations for status, questions/instructions, pause, resume, stop, and cleanup.
- FR-005: Conversational supervisor requests MUST resolve to the same validated operations as explicit controls.
- FR-006: Crosby MUST require confirmation before stopping a worker, discarding unmerged work, or removing a task worktree/tab.
- FR-007: A child MUST be claimed before launch and restored to its previous runnable state if Herdr launch cannot complete.
- FR-008: Crosby MUST fail closed when Herdr is unavailable; it MUST NOT fall back to headless execution.
- FR-009: Crosby MUST use isolated managed workspaces for every task and a separate managed workspace for parent integration.
- FR-010: Crosby MUST NOT modify the operator’s normal project checkout.
- FR-011: Crosby MUST cap all active workers at two globally.
- FR-012: Crosby MUST run tasks concurrently only when each has explicit parallel opt-in, no unresolved blockers, valid disjoint file scopes, and available capacity.
- FR-013: Crosby MUST compare scopes for tasks targeting the same repository, including tasks under different active parents.
- FR-014: Crosby MUST schedule legacy tasks lacking the new metadata sequentially only and warn the supervisor.
- FR-015: Crosby MUST preserve deterministic prioritization for pending eligible tasks and prioritize an explicitly launched parent ahead of watcher-only candidates without interrupting active workers.
- FR-016: A worker MUST report completion or human blocking explicitly in structured form; Herdr idle state alone MUST NOT finalize a task.
- FR-017: Workers MUST remain directly steerable in their task tabs, but direct steering MUST NOT bypass scope validation, verification, or integration safeguards.
- FR-018: Crosby MUST validate all changed paths against the task scope before integration.
- FR-019: Crosby MUST run the task’s declared minimum verification before integration, unless it explicitly declares `none`.
- FR-020: Crosby MAY allow workers to run additional verification beyond the declared minimum.
- FR-021: Crosby MUST merge completed task branches serially into the parent feature branch and MUST NOT merge them directly into `main`.
- FR-022: Crosby MUST mark a child `Done` only after successful scope validation, task verification, and parent-branch integration.
- FR-023: Crosby MUST retain a failed, blocked, out-of-scope, or conflicted task’s tab and worktree and move the child to `In Review`.
- FR-024: Active parents MUST remain in `Execute`; child issues MUST carry active task state. A parent moves to `In Review` only after all children are done and final integration verification succeeds.
- FR-025: Crosby MUST obtain required parent integration checks from version-controlled project execution configuration and MUST fail closed when that configuration is absent or invalid.
- FR-026: Crosby MUST persist enough worker registry state to reconcile and adopt workers after supervisor or Herdr restart.
- FR-027: Crosby MUST attempt at most one automatic same-worktree recovery after a worker crash and record that attempt.
- FR-028: Detailed worker reports MUST be posted to the child issue.
- FR-029: Parent comments MUST be concise: completion/link entries, human-action notices, and a concise final status/link summary only.
- FR-030: The shared issue-authoring workflow MUST require machine-readable path scope, parallel eligibility, dependency, and minimum-verification metadata for newly created executable tasks.
- FR-031: Newly authored scopes MUST permit only repository-relative exact files or whole-folder declarations.

### Non-Functional Requirements

- NFR-001: State transitions and recovery decisions MUST be durable, observable, and deterministic.
- NFR-002: Registry updates MUST be crash-safe so a partial write cannot cause duplicate worker launch.
- NFR-003: External Herdr, Git, and Linear responses MUST be validated before state mutation; failures MUST include an operator recovery path.
- NFR-004: The scheduler MUST avoid busy polling and must not consume worker capacity for non-runnable work.
- NFR-005: Human-readable supervisor output MUST remain compact; full task evidence belongs in the task tab and child issue.
- NFR-006: Existing Crosby commands for push/review and legacy sequential child issues MUST remain usable unless an explicit safety constraint prevents execution.

## Key Entities

- **Supervisor**: The trigger-tab Crosby control plane that owns scheduling, persistence, integration, and operator controls.
- **Worker record**: Durable mapping from child issue key to its parent, workspaces, task branch, Herdr IDs, scope, verification contract, attempt count, and lifecycle state.
- **Task contract**: The child issue’s path scope, parallel eligibility, dependencies, and minimum verification declaration.
- **Managed repository**: The Crosby-controlled Git source and workspaces used for task execution and parent integration, separate from the operator’s checkout.
- **Structured worker report**: Explicit task completion or block data submitted by the worker and used for Linear reporting and integration decisions.

## Success Criteria

- SC-001: No launched child runs as an unseen headless worker.
- SC-002: The operator can identify and inspect any active child by its Linear key in Herdr.
- SC-003: Two eligible independent tasks can execute concurrently without sharing a writable checkout.
- SC-004: No task is marked `Done` before it is merged into the parent branch and passes its required task-level safeguards.
- SC-005: Restarting the supervisor does not duplicate active work.
- SC-006: Parent Linear discussion remains concise while child issues contain complete technical evidence.
- SC-007: Newly generated tasks consistently provide the scheduler metadata needed for safe parallelism.

## Constitutional Compliance

- ✅ **Core deterministic, text-first workflow rules**: scheduling metadata, worker reports, lifecycle records, and configuration are explicit and parseable.
- ✅ **Process automation durability**: state is persisted outside any individual Pi session and reconciled across restart.
- ✅ **Guardrails**: ambiguous/missing configuration, unavailable Herdr, scope violations, merge conflicts, and destructive operations fail safely.
- ✅ **Recovery paths**: the supervisor provides actionable recovery for failed launch, failed worker recovery, invalid metadata, and integration failure.
- ✅ **Small independently completable slices**: the work remains child-task based while adding isolation and strict integration boundaries.

## Out of Scope

- Automatic resolution of Git merge conflicts or scope violations.
- Automatically splitting overly broad child tasks.
- Automatically changing an operator’s normal checkout.
- Direct merge into `main`.
- More than two concurrent workers in this feature.
- Replacing Linear as the workflow source of truth.
