# Spec: COA-116 The Crosby Loop

**Status**: DRAFT
**Source**: https://linear.app/coachcw/issue/COA-116/the-crosby-loop
**Priority**: High
**Work Type**: process-automation

## Summary
Create `/crosby`, a Pi supervisor workflow that executes a parent Linear issue as a queue of child execution issues. The supervisor must preserve fresh context per child by delegating each child to an isolated worker, continue past blocked or review-needed children when other independent children remain runnable, and keep Linear workflow states and parent progress comments up to date.

The design must separate concerns clearly:
- the **supervisor** owns queue selection and `Building` transitions
- the **worker** owns single-child execution and final child outcome (`Done` or `Review`)
- the **parent** moves to `Building` when the first child starts and to `Review` when all children are `Done`

---

## User Scenarios & Testing

### User Story 1 — Run a parent issue autonomously (Priority: P1)
As an operator, I want to run `/crosby COA-116-PARENT` once and have Pi continue through runnable child issues without requiring me to manually start each child.

**Why this priority**: This is the core value of the workflow.

**Independent Test**: Create a parent with multiple `Build Ready` children and verify `/crosby` runs them sequentially until no runnable children remain.

**Acceptance Scenarios**:
1. **Given** a parent issue with three `Build Ready` child issues and no blockers, **When** I run `/crosby PARENT-KEY`, **Then** Pi runs the children one at a time in isolated child contexts until all three have been processed.
2. **Given** a parent issue with no child issues, **When** I run `/crosby PARENT-KEY`, **Then** Pi stops with a clear error explaining that `/crosby` requires a parent issue with child execution issues.

### User Story 2 — Skip blocked work and continue independent work (Priority: P1)
As an operator, I want blocked or review-needed child issues to not stop unrelated runnable child issues from completing.

**Why this priority**: This is the queue policy the workflow is being introduced to support.

**Independent Test**: Create one blocked child, one review-needed child, and one runnable child; verify the runnable child still runs.

**Acceptance Scenarios**:
1. **Given** one child is dependency-blocked and another child is `Build Ready` with no blockers, **When** `/crosby` runs, **Then** it skips the blocked child and runs the independent child.
2. **Given** one child is already in `Review` and another child is runnable, **When** `/crosby` runs, **Then** it skips the `Review` child and continues with the runnable child.

### User Story 3 — Keep Linear workflow states correct (Priority: P1)
As an operator, I want child and parent workflow states updated deterministically so Linear reflects what Crosby is doing.

**Why this priority**: Reliable state transitions are required for team visibility and safe resumption.

**Independent Test**: Verify state transitions on first child start, successful completion, and human-needed review outcomes.

**Acceptance Scenarios**:
1. **Given** a selected child is about to run, **When** the supervisor begins execution for that child, **Then** the supervisor moves the child from `Build Ready` to `Building` before spawning the worker.
2. **Given** no child has started yet and the first child begins, **When** the supervisor marks that child `Building`, **Then** the supervisor also moves the parent issue to `Building` if it is not already there.
3. **Given** a worker completes a child successfully, **When** execution finishes, **Then** the worker moves the child to `Done`.
4. **Given** a worker determines human action is needed, **When** execution finishes, **Then** the worker moves the child to `Review` and records the required human action.
5. **Given** all child issues are now `Done`, **When** the queue completes, **Then** the parent issue is moved to `Review`.

### User Story 4 — Preserve fresh child context (Priority: P1)
As an operator, I want each child issue to run in an isolated context so one child’s execution does not pollute another’s.

**Why this priority**: Fresh-context execution is the core discipline inherited from Ralph Loop.

**Independent Test**: Verify each child is executed by a separate worker/subagent invocation rather than a single long-running child execution context.

**Acceptance Scenarios**:
1. **Given** multiple child issues are processed in one `/crosby` run, **When** the supervisor starts each child, **Then** each child is delegated to a fresh isolated worker context.
2. **Given** a worker completes one child, **When** the supervisor starts the next child, **Then** the next child does not reuse the previous child worker context.

### User Story 5 — Keep parent progress visible (Priority: P2)
As an operator, I want the parent issue to accumulate concise progress updates per child and a final consolidated summary when all children are done.

**Why this priority**: Parent-level visibility is required because each child runs in its own isolated context.

**Independent Test**: Verify each finished child adds a parent progress comment and the final completion adds a consolidated wrap-up.

**Acceptance Scenarios**:
1. **Given** a child ends in `Done` or `Review`, **When** the worker finishes, **Then** it posts a concise parent progress comment summarizing that child’s outcome.
2. **Given** all child issues are `Done`, **When** the queue completes, **Then** the final completion path posts a consolidated parent summary comment covering all child outcomes and verification notes.

### User Story 6 — Stop cleanly when nothing runnable remains (Priority: P2)
As an operator, I want `/crosby` to stop with a clear summary when there is no more runnable work, even if some children remain blocked or in review.

**Why this priority**: This makes the queue safe to resume and easy to understand.

**Independent Test**: Verify the final output groups remaining non-runnable items by reason.

**Acceptance Scenarios**:
1. **Given** some children are `Done`, some are blocked, and some are `Review`, **When** no runnable children remain, **Then** `/crosby` stops and reports which children remain and why they were skipped.
2. **Given** one or more children are in `Review`, **When** `/crosby` stops, **Then** the output includes an attention-needed summary listing the human action required for each review item.

---

## Edge Cases
- Parent issue key resolves to a non-parent issue.
- Parent has zero child issues.
- Two operators invoke `/crosby` for the same parent at nearly the same time.
- A child is already in `Building` when `/crosby` starts; it must be skipped, not auto-resumed.
- A child is in a non-standard state that is neither `Build Ready`, `Building`, `Done`, nor `Review`.
- Linear state update succeeds for parent but fails for child, or vice versa.
- Worker fails before returning a structured result.
- Child issue is too broad for one clean execution loop and must be surfaced as a splitting problem.
- Parent has a mix of dependency-linked children and independent children.
- Review-needed children must not be counted as complete for parent completion.
- Final consolidated summary must not be posted until all children are actually `Done`.

---

## Requirements

### Functional Requirements
- FR-001: The system MUST expose a Pi command named `/crosby` that accepts exactly one parent Linear issue key.
- FR-002: The system MUST validate that the supplied issue is a parent issue with child execution issues before starting queue execution.
- FR-003: The system MUST fetch the parent issue and its child issues from Linear at the start of execution and after each child finishes.
- FR-004: The system MUST classify child issues into runnable and non-runnable groups using deterministic rules.
- FR-005: A child issue MUST be considered runnable only if it is in `Build Ready`, is not already `Building`, `Done`, or `Review`, and has no unresolved blockers.
- FR-006: The system MUST process child issues sequentially, one child at a time.
- FR-007: The system MUST delegate each child issue to an isolated worker context.
- FR-008: The supervisor MUST move a selected child issue to `Building` before spawning the worker.
- FR-009: The supervisor MUST move the parent issue to `Building` when the first child begins, if the parent is not already `Building`.
- FR-010: The worker MUST execute exactly one child issue and MUST NOT implement sibling child issues in the same run.
- FR-011: The worker MUST follow the existing single-child execution rules from Ralph Loop, including verification-first execution discipline.
- FR-012: On successful child completion, the worker MUST move the child issue to `Done`.
- FR-013: If human action is required to proceed, the worker MUST move the child issue to `Review` and record the required human action in a comment.
- FR-014: The system MUST continue processing other runnable children even if other children are blocked or in `Review`.
- FR-015: The system MUST skip child issues that are blocked, in `Review`, already `Done`, already `Building`, or otherwise non-runnable.
- FR-016: The system MUST post a concise parent progress comment for every child that ends in `Done` or `Review`.
- FR-017: Parent progress comments MUST include at minimum the child issue key and title, outcome, key changes, tests/verifications run, and follow-up notes.
- FR-018: When all child issues are `Done`, the system MUST post a final consolidated parent summary comment.
- FR-019: When all child issues are `Done`, the system MUST move the parent issue to `Review`.
- FR-020: When no runnable children remain, the system MUST stop and present a grouped summary of remaining children by reason.
- FR-021: When review-needed children remain, the final operator-facing output MUST include an attention-needed summary with required human actions.
- FR-022: The system MUST skip any child already in `Building` when `/crosby` starts; it MUST NOT auto-resume that child in MVP behavior.
- FR-023: Child execution order MUST respect dependency/topological ordering where applicable. Among children with no blocking dependency relationship, the system MUST use a deterministic stable fallback order of Linear priority first and issue key ascending second.
- FR-024: The final parent summary MUST NOT treat `Review` children as complete.
- FR-025: The system MUST prevent multiple active `/crosby` supervisor runs from claiming work for the same parent issue concurrently.
- FR-026: If a second `/crosby` invocation detects that another supervisor has already claimed or started runnable work for the same parent, it MUST fail closed with a clear operator-facing message instead of continuing.
- FR-027: If the supervisor cannot move a selected child issue to `Building`, it MUST NOT spawn the worker for that child and MUST report the failure immediately.
- FR-028: If the supervisor cannot move the parent issue to `Building` when the first child starts, it MUST stop queue execution and report the failure before spawning the worker.
- FR-029: If the worker completes child execution but cannot persist the final child state (`Done` or `Review`) or required child comment, it MUST return a fatal outcome to the supervisor and MUST NOT treat the child as successfully processed.
- FR-030: If the system cannot post a required parent progress comment after a child outcome is finalized, it MUST report the failure explicitly; the child outcome remains authoritative, and the run MAY stop after that child with recovery guidance rather than continue silently.
- FR-031: If the system cannot post the final consolidated parent summary comment or cannot move the parent issue to `Review`, it MUST report the failure explicitly and MUST NOT claim full parent completion.

### Non-Functional Requirements
- NFR-001: The workflow MUST optimize for deterministic queue behavior over opportunistic parallelism.
- NFR-002: The supervisor MUST own `Building` transitions so active-state behavior remains deterministic and cheap.
- NFR-003: The worker MUST return a structured result that the supervisor can evaluate without reinterpreting freeform output.
- NFR-004: Parent and child Linear state transitions MUST be observable and failure-reported.
- NFR-005: The workflow MUST minimize repeated broad context loading by restricting workers to one child issue and only the minimum required parent/sibling context.
- NFR-006: The command output MUST clearly distinguish successful completions, blocked items, review-needed items, and fatal failures.
- NFR-007: The MVP MUST assume a single active repo/worktree and single child execution at a time.
- NFR-008: The workflow MUST be resumable by rerunning `/crosby PARENT-KEY` after human intervention or dependency resolution.
- NFR-009: The structured worker result MUST include, at minimum: child issue key, child issue title, terminal outcome (`done`, `review`, or `fatal`), concise summary, key changes, tests/verifications run, and required human action when applicable.
- NFR-010: For `fatal` and `review` outcomes, the structured worker result MUST include operator-relevant recovery notes that the supervisor can surface directly.

### Key Entities
- **Crosby Supervisor**: The Pi command/extension layer that selects runnable child issues, owns `Building` state transitions, launches workers, and controls loop progression.
- **Crosby Worker**: An isolated child-execution agent/subagent that handles exactly one child issue and returns a structured outcome.
- **Parent Issue**: The Linear issue that groups child execution issues and receives progress/final summary comments.
- **Child Issue**: A thin execution issue under the parent that must be independently runnable in a fresh context.
- **Runnable Child**: A child in `Build Ready` with no unresolved blockers and not already in `Building`, `Done`, or `Review`.
- **Attention-Needed Summary**: The grouped stop summary showing review items and required human actions when the queue cannot continue.

---

## Success Criteria
- SC-001: An operator can start the queue with `/crosby ISSUE-KEY` and Pi continues through runnable child issues without manual relaunch per child.
- SC-002: Blocked or review-needed children do not prevent independent runnable children from being completed.
- SC-003: The first runnable child moves to `Building` before worker execution begins.
- SC-004: The parent moves to `Building` when the first child starts.
- SC-005: Completed children reliably end in `Done`; human-needed children reliably end in `Review`.
- SC-006: Every completed/reviewed child adds a concise parent progress comment.
- SC-007: The parent moves to `Review` only when all child issues are `Done`.
- SC-008: Rerunning `/crosby` after human intervention or dependency changes can continue processing remaining runnable work without corrupting state.

---

## Acceptance Criteria
1. **Given** a valid parent issue with child issues, **When** `/crosby PARENT-KEY` starts, **Then** the system validates the parent and loads the child queue before attempting execution.
2. **Given** a selected child is runnable, **When** the supervisor begins work, **Then** it moves that child to `Building` before spawning the worker.
3. **Given** the selected child is the first child to start, **When** the supervisor marks it `Building`, **Then** the parent is moved to `Building` if not already there.
4. **Given** a child has unresolved blockers, **When** `/crosby` evaluates the queue, **Then** that child is skipped and other runnable children may still proceed.
5. **Given** a child is already in `Review`, **When** `/crosby` evaluates the queue, **Then** that child is skipped and other runnable children may still proceed.
6. **Given** a child is already in `Building`, **When** `/crosby` evaluates the queue, **Then** that child is skipped and is not auto-resumed.
7. **Given** a worker completes successfully, **When** it exits, **Then** the child is moved to `Done` and a parent progress comment is posted.
8. **Given** a worker determines human action is required, **When** it exits, **Then** the child is moved to `Review`, a child comment explains the human action, and a parent progress comment is posted.
9. **Given** at least one runnable child remains after a previous child finishes, **When** the supervisor refreshes queue state, **Then** it selects and runs the next runnable child without requiring a new user command.
10. **Given** no runnable children remain and not all children are `Done`, **When** `/crosby` stops, **Then** the operator-facing summary groups remaining children by reason and includes an attention-needed summary for `Review` items.
11. **Given** all child issues are `Done`, **When** the final child outcome is processed, **Then** the system posts a consolidated parent summary comment and moves the parent to `Review`.
12. **Given** a non-parent issue key or parent with no children is supplied, **When** `/crosby` is invoked, **Then** the system fails closed with a clear recovery message.
13. **Given** one `/crosby PARENT-KEY` run has already claimed or started a child for that parent, **When** a second `/crosby PARENT-KEY` invocation begins, **Then** the second invocation exits without claiming work and reports that another active supervisor run is already in progress.
14. **Given** two supervisors evaluate the same runnable child nearly simultaneously, **When** one supervisor successfully moves the child to `Building` first, **Then** the other supervisor re-checks current child state, does not start that child, and exits or continues only with other still-runnable children.
15. **Given** a selected child cannot be moved to `Building`, **When** the supervisor attempts to claim it, **Then** no worker is started for that child and the run stops with a clear recovery message.
16. **Given** the first child is claimed but the parent cannot be moved to `Building`, **When** the supervisor performs the parent transition, **Then** it stops before worker execution and reports the failed parent transition.
17. **Given** a worker finishes execution but cannot persist the child’s final state or required child comment, **When** the worker returns control, **Then** the supervisor reports a fatal child outcome and does not count that child as completed.
18. **Given** a child outcome is finalized but the required parent progress comment fails to post, **When** the run handles the result, **Then** the failure is surfaced explicitly and the run does not continue silently as if reporting succeeded.
19. **Given** all children are `Done` but the final parent summary comment or parent transition to `Review` fails, **When** queue completion runs, **Then** the system reports incomplete finalization and does not claim full parent completion.
20. **Given** a worker finishes a child run, **When** it returns control to the supervisor, **Then** the result includes the minimum required structured fields for outcome handling and parent reporting.
21. **Given** a worker returns a `review` or `fatal` outcome, **When** the supervisor formats operator-facing output, **Then** it can surface the required human action or recovery notes without inferring missing details from freeform text.
22. **Given** multiple runnable children have no blocking dependency relationship, **When** the supervisor selects the next child, **Then** it chooses by Linear priority first and issue key ascending second.
23. **Given** the same parent queue state is evaluated multiple times without state changes, **When** the supervisor computes runnable order, **Then** it produces the same child selection order each time.

---

## Constitutional Compliance
- ✅ Core shared-workflow routing: Work type is explicit and process-automation-oriented.
- ✅ Process automation addition: Optimizes for durable workflow behavior, explicit states, deterministic routing, and safe failure modes.
- ✅ Guardrails: Blocked/non-runnable items fail safely and are reported explicitly.
- ✅ Recovery path: Missing queue prerequisites, invalid parent selection, and review-needed states are surfaced with clear operator recovery.
- ✅ Small slices: The workflow assumes thin child execution issues and rejects/flags issues that are too broad.

---

## Out of Scope
- Parallel execution of multiple child issues at once.
- Automatic resumption of pre-existing `Building` children.
- Automatic splitting of overly broad child issues.
- Multi-worktree or multi-branch execution in MVP.
- Replacing Ralph Loop’s single-child execution discipline.
- Arbitrary non-Linear multi-task orchestration beyond a parent/child Linear queue.
