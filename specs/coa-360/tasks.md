# Tasks: COA-360 Crosby Herdr-supervised execution

**Input**: [spec.md](spec.md), [plan.md](plan.md)  
**Execution strategy**: Bootstrap with current Crosby sequential execution. All child descriptions already contain the future Crosby execution contract; current Crosby safely ignores it.  
**Work Type**: process-automation

## Task contract format

Every child issue below is AFK and includes:

- `Parallel`: scheduler eligibility after the new Crosby exists;
- `File scope`: exact repository-relative files/folders the worker may change;
- `Verification`: minimum command(s), or `none` for a documentation-only task.

## Execution Window 1 — Authoring and contract foundation

### T001 — Update generated task metadata for Crosby scheduling

**Linear**: [COA-361](https://linear.app/coachcw/issue/COA-361/publish-crosby-task-contract-metadata-in-shared-issue-workflows)

- **Type**: AFK
- **Parallel**: allowed
- **File scope**:
  - `shared-workflows/portable/skills/to-issues/SKILL.md`
  - `shared-workflows/portable/skills/tasks/SKILL.md`
- **Verification**: none
- **Dependencies**: none
- **Traceability**: FR-030, FR-031; User Story 6
- **Outcome**: New generated executable issues contain machine-readable parallel, scope, and verification metadata; `[P]` is aligned with the same criteria.

### T002 — Add Crosby task-contract and project-configuration validation

**Linear**: [COA-362](https://linear.app/coachcw/issue/COA-362/add-crosby-task-contract-and-project-configuration-validation)

- **Type**: AFK
- **Parallel**: allowed
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/task-contract.mjs`
  - `shared-workflows/pi/extensions/crosby/task-contract.test.mjs`
  - `shared-workflows/pi/extensions/crosby/project-config.mjs`
  - `shared-workflows/pi/extensions/crosby/project-config.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/task-contract.test.mjs shared-workflows/pi/extensions/crosby/project-config.test.mjs`
- **Dependencies**: none
- **Traceability**: FR-012–FR-014, FR-019–FR-020, FR-025, FR-030–FR-031; User Stories 3, 4, 6
- **Outcome**: Crosby can deterministically classify modern/legacy contracts, reject invalid scopes/configuration, and decide scope overlap without changing dispatch behavior yet.

[WINDOW_CHECKPOINT_1: task-authoring metadata and pure scheduling contracts are independently verified]

## Execution Window 2 — Durable isolation and Herdr protocol

### T003 — Add durable Crosby registry and managed Git workspace primitives

**Linear**: [COA-363](https://linear.app/coachcw/issue/COA-363/add-durable-crosby-registry-and-managed-git-workspace-primitives)

- **Type**: AFK
- **Parallel**: allowed
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/registry.mjs`
  - `shared-workflows/pi/extensions/crosby/registry.test.mjs`
  - `shared-workflows/pi/extensions/crosby/managed-git.mjs`
  - `shared-workflows/pi/extensions/crosby/managed-git.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/registry.test.mjs shared-workflows/pi/extensions/crosby/managed-git.test.mjs`
- **Dependencies**: T002
- **Traceability**: FR-009–FR-010, FR-018, FR-021–FR-023, FR-026–FR-027; User Stories 3–5
- **Outcome**: Crosby can atomically persist task records, manage an isolated Git source/worktrees, validate changed paths, and preserve merge-conflict/out-of-scope evidence.

### T004 — Add validated Herdr adapter and worker report protocol

**Linear**: [COA-364](https://linear.app/coachcw/issue/COA-364/add-validated-herdr-adapter-and-structured-worker-report-protocol)

- **Type**: AFK
- **Parallel**: allowed
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/herdr-client.mjs`
  - `shared-workflows/pi/extensions/crosby/herdr-client.test.mjs`
  - `shared-workflows/pi/extensions/crosby/worker-protocol.mjs`
  - `shared-workflows/pi/extensions/crosby/worker-protocol.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/herdr-client.test.mjs shared-workflows/pi/extensions/crosby/worker-protocol.test.mjs`
- **Dependencies**: T002
- **Traceability**: FR-001–FR-002, FR-008, FR-016–FR-017, FR-026–FR-027; User Stories 1, 2, 5
- **Outcome**: Crosby has testable Herdr process operations and explicit worker completion/block report validation, without yet changing the production scheduler.

[WINDOW_CHECKPOINT_2: state, Git, Herdr, and worker-report building blocks have isolated tests]

## Execution Window 3 — Visible worker launch

### T005 — Launch and recover one visible Crosby worker from the supervisor

**Linear**: [COA-365](https://linear.app/coachcw/issue/COA-365/launch-and-recover-a-visible-herdr-crosby-worker)

- **Type**: AFK
- **Parallel**: sequential
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/index.ts`
  - `shared-workflows/pi/extensions/crosby/lib-v2.mjs`
  - `shared-workflows/pi/extensions/crosby/lib-v2.test.mjs`
  - `shared-workflows/pi/extensions/crosby/scheduler.mjs`
  - `shared-workflows/pi/extensions/crosby/scheduler.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/lib-v2.test.mjs shared-workflows/pi/extensions/crosby/scheduler.test.mjs`
- **Dependencies**: T003, T004
- **Traceability**: FR-001–FR-008, FR-016–FR-017, FR-024, FR-026–FR-027; User Stories 1, 2, 5
- **Outcome**: A manually started parent claims one child, creates a named Herdr task tab/interactive Pi worker, records it durably, rolls back failed launch, and adopts/retries it safely after restart.

[WINDOW_CHECKPOINT_3: no new task can silently launch headlessly]

## Execution Window 4 — Safe global scheduling and integration

### T006 — Schedule, validate, and integrate isolated worker tasks

**Linear**: [COA-366](https://linear.app/coachcw/issue/COA-366/schedule-and-integrate-isolated-herdr-worker-tasks-safely)

- **Type**: AFK
- **Parallel**: sequential
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/index.ts`
  - `shared-workflows/pi/extensions/crosby/lib-v2.mjs`
  - `shared-workflows/pi/extensions/crosby/lib-v2.test.mjs`
  - `shared-workflows/pi/extensions/crosby/scheduler.mjs`
  - `shared-workflows/pi/extensions/crosby/scheduler.test.mjs`
  - `shared-workflows/pi/extensions/crosby/linear-reporting.mjs`
  - `shared-workflows/pi/extensions/crosby/linear-reporting.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/lib-v2.test.mjs shared-workflows/pi/extensions/crosby/scheduler.test.mjs shared-workflows/pi/extensions/crosby/linear-reporting.test.mjs`
- **Dependencies**: T005
- **Traceability**: FR-011–FR-015, FR-018–FR-25, FR-028–FR-029; User Stories 3–5
- **Outcome**: Scheduler enforces global two-worker capacity and scope/blocker rules, serializes integration, preserves parent `Execute`, runs child/final checks, and posts detailed child/concise parent Linear reports.

[WINDOW_CHECKPOINT_4: eligible tasks can run concurrently and are integrated safely]

## Execution Window 5 — Operator controls and documentation

### T007 — Add supervisor controls, conversational tools, and operator documentation

**Linear**: [COA-367](https://linear.app/coachcw/issue/COA-367/add-crosby-supervisor-controls-and-operator-documentation)

- **Type**: AFK
- **Parallel**: sequential
- **File scope**:
  - `shared-workflows/pi/extensions/crosby/index.ts`
  - `shared-workflows/pi/extensions/crosby/README.md`
  - `shared-workflows/pi/extensions/crosby/scheduler.mjs`
  - `shared-workflows/pi/extensions/crosby/scheduler.test.mjs`
  - `shared-workflows/pi/extensions/crosby/linear-reporting.mjs`
  - `shared-workflows/pi/extensions/crosby/linear-reporting.test.mjs`
- **Verification**:
  - `node --test shared-workflows/pi/extensions/crosby/lib-v2.test.mjs shared-workflows/pi/extensions/crosby/scheduler.test.mjs shared-workflows/pi/extensions/crosby/linear-reporting.test.mjs`
- **Dependencies**: T001, T006
- **Traceability**: FR-003–FR-006, FR-015, FR-023, FR-028–FR-029; User Stories 1, 2, 5, 6
- **Outcome**: Supervisor exposes explicit and conversational status/ask/pause/resume/stop/cleanup operations, confirms destructive requests, documents migration/recovery, and provides compact visible task state.

[WINDOW_CHECKPOINT_5: full COA-360 operator flow is documented and verified]

## Dependency Graph

```text
T001 ───────────────────────────────────────────────┐
                                                     ├─> T007
T002 ──> T003 ──┐                                   │
  └──> T004 ───┴─> T005 ──> T006 ───────────────────┘
```

## Bootstrap Note

Current Crosby will execute these child issues sequentially and ignores the new contract block. That is safe for the bootstrap. Once T005/T006 land, later/new parents can use Herdr-managed visible workers and parallel scheduling.
