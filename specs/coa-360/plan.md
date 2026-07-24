# Implementation Plan: Crosby Herdr-supervised execution

**Branch**: `cameronwalsh/coa-360-crosby-herdr-supervised-execution`  
**Date**: 2026-07-23  
**Spec**: [spec.md](spec.md)  
**Work Type**: process-automation

## Summary

Replace Crosby’s synchronous `pi -p --no-session` child runner with a durable control plane that launches interactive Pi workers in Herdr tabs. The supervisor tab remains responsive because it schedules and reconciles background worker records instead of awaiting a headless process for each child.

The implementation separates six concerns that currently overlap in the extension entrypoint:

1. task-contract parsing and parallel eligibility;
2. persistent registry and recovery;
3. Herdr process/agent control;
4. managed Git source, task worktrees, and parent integration;
5. Linear lifecycle/reporting; and
6. supervisor commands and conversational tools.

All worker branches merge serially into the parent feature branch in a Crosby-managed integration worktree. The operator’s ordinary checkout is never used as a writable worktree.

## Technical Context

- **Runtime**: TypeScript Pi extension plus Node ESM helper modules.
- **Supervisor host**: Interactive Pi inside Herdr.
- **Worker host**: Interactive Pi agents started by Herdr, one per child task tab.
- **External controls**: Herdr CLI/socket API, Git CLI, Linear CLI, GitHub CLI, and existing Claude review CLI.
- **Persistence**: Atomic JSON registry and lock files in per-user application data; Pi session entries remain supplementary transcript/audit data only.
- **Current active code**: `shared-workflows/pi/extensions/crosby/index.ts` and `lib-v2.mjs`.
- **Existing test style**: Node’s built-in test runner in `lib-v2.test.mjs`; retain dependency injection for Linear/Git/worker operations and add fakes for Herdr and persistence.

## Constitution Check

- ✅ **Canonical source of truth**: reusable workflow rules remain under `shared-workflows`; Pi-specific runtime code remains under `shared-workflows/pi/extensions/crosby`.
- ✅ **Deterministic text-first controls**: task metadata, registry records, configuration, and worker reports have explicit schemas.
- ✅ **Fail closed**: invalid configuration/metadata, unavailable Herdr, unsafe scope overlap, and failed destructive confirmation block the action with recovery guidance.
- ✅ **Durable process automation**: recovery is based on an external registry reconciled against Herdr, Git, and Linear—not one supervisor’s chat history.
- ✅ **Small slices**: task isolation is preserved; concurrency is opt-in and bounded.

No constitution override is required.

## Target Structure

```text
shared-workflows/
├── pi/extensions/crosby/
│   ├── index.ts                    # extension registration and composition only
│   ├── lib-v2.mjs                  # retained queue/domain helpers; reduced orchestration role
│   ├── task-contract.mjs           # child metadata parsing, validation, overlap checks
│   ├── registry.mjs                # schema, atomic persistence, locking, reconciliation helpers
│   ├── herdr-client.mjs            # validated Herdr CLI/API adapter
│   ├── managed-git.mjs             # managed clone/worktrees, diff/scope/merge operations
│   ├── scheduler.mjs               # capacity, dispatch, recovery, serialized integration
│   ├── worker-protocol.mjs         # completion/block report schemas and worker tool helpers
│   ├── linear-reporting.mjs        # concise parent and detailed child reporting
│   ├── *.test.mjs                  # focused unit/integration-style tests
│   └── README.md
├── portable/skills/to-issues/SKILL.md
└── portable/skills/tasks/SKILL.md

specs/coa-360/
├── spec.md
├── research.md
├── plan.md
├── quickstart.md
└── tasks.md                         # created only after plan approval
```

The exact module names may vary during implementation, but boundaries must remain. Do not add another large command-handler-only implementation to `index.ts`.

## Data and Protocol Design

### 1. Project execution configuration

Every repository Crosby manages must provide `.pi/crosby.json` before the parent can launch. Initial schema:

```json
{
  "version": 1,
  "integrationChecks": ["vp check", "vp run typecheck"]
}
```

Rules:

- `version` is required and allows later compatibility handling.
- `integrationChecks` is a non-empty ordered list of shell commands.
- Commands run only once after every child has integrated, in the managed parent integration worktree.
- Child task verification is not derived from this file.
- Missing, malformed, or unsupported configuration blocks launch with a concrete recovery message and a minimal config example.

### 2. Child task contract

`to-issues` will generate this canonical description block for every new executable child:

```markdown
## Crosby execution

- Parallel: allowed
- File scope:
  - `apps/web/src/login/**`
  - `apps/web/src/routes/login.test.ts`
- Verification:
  - `vp test apps/web/src/routes/login.test.ts`
```

Allowed values:

- `Parallel`: `allowed` or `sequential`.
- `File scope`: repository-relative exact file path or directory form ending `/**`; no absolute paths, negation, `..`, or whole-repository catch-all.
- `Verification`: one or more commands, or a single `none` value.

Parser result distinguishes **valid modern**, **invalid modern**, and **legacy missing** metadata. Invalid declared metadata fails closed. Missing metadata follows the documented legacy sequential path and raises a supervisor warning; it cannot qualify for scope enforcement or parallel scheduling.

`tasks` must only mark `[P]` where the equivalent task contracts are explicit, blocker-free, and disjoint. `to-issues` publishes that metadata with all new AFK/HITL task details.

### 3. Durable worker registry

Store one versioned registry under the user application-data directory, keyed by a normalized repository identity and parent key. Use an exclusive lock plus write-to-temp-and-rename for every update.

A parent record contains at minimum:

- repository identity, source remote, parent key, parent branch, configuration digest, and parent base SHA;
- managed source location and integration worktree location;
- scheduler state (`active`, `paused`, `finalizing`, `review-required`, `completed`);
- pending/manual priority state and timestamps.

A worker record contains at minimum:

- parent and child keys, issue path, task contract, base SHA, task branch, and worktree path;
- Herdr workspace/tab/pane/agent identifiers;
- lifecycle (`claimed`, `launching`, `working`, `blocked`, `reported`, `integrating`, `done`, `review-required`, `stopped`, `orphaned`);
- structured report, scope/verification/integration outcomes, retry count, and recovery notes.

Registry status is the scheduler’s source of truth for in-flight work. Linear remains the workflow source of truth for issue state; reconciliation resolves disagreement explicitly rather than silently overwriting either system.

### 4. Managed Git source and worktrees

For each repository, create or reuse a Crosby-managed bare clone/cache under the registry root. Use it to create:

- exactly one parent integration worktree on the parent feature branch; and
- one task worktree and task branch per active child.

Before launch, fetch/reconcile the managed source and record a task base SHA. On worker report:

1. compute the full task change set against that base;
2. reject paths outside the declared scope when a modern scope exists;
3. run the task’s minimum verification unless it is `none`;
4. commit remaining task changes if the worker has not already committed them;
5. merge the task branch into the parent integration worktree with no automatic conflict resolution; and
6. mark the child `Done` only after merge succeeds.

Merges are serialized even when worker execution is parallel. Conflicts, verification failure, or scope violation preserve the task worktree/tab and move the child to `In Review`.

### 5. Herdr adapter and worker protocol

Create a single adapter around `pi.exec` calls to Herdr. It must validate command result/JSON shape and expose operations rather than shelling out throughout the scheduler:

- inspect session snapshot and existing agents;
- create a tab with the task worktree as CWD and child key as label;
- resolve the tab’s root pane;
- start an interactive Pi agent in that pane;
- prompt, wait, read, rename, and inspect the agent;
- preserve focus unless an operator explicitly asks to focus a task.

The worker starts with a bounded bootstrap prompt containing only task, parent, task contract, managed-worktree, and reporting instructions. It may be directly steered in its tab.

Register a worker-only structured report tool. A report contains outcome (`complete` or `blocked`), summary, changed-path/commit evidence, verification information, required human action, and recovery notes. The tool validates the report, persists it in the registry, and terminates the worker turn when appropriate. A blocked report emits the existing Pi/Herdr blocked event so the Herdr Agents column visibly flags the task.

Do not infer completion from `idle`, `done`, terminal text, or a Pi session file.

### 6. Scheduler and Linear lifecycle

Replace synchronous queue loops with an idempotent scheduler tick:

1. acquire the registry scheduler lock;
2. reconcile persisted records with Herdr snapshot, Git worktrees/branches, and current Linear queues;
3. process submitted worker reports and serialized integrations;
4. select pending candidates across manual and watch sources;
5. apply global capacity of two and same-repository scope compatibility;
6. claim a selected child in Linear (`Build`) before launch;
7. create/register/start the Herdr worker; revert the child to `Ready to Build` if launch fails;
8. release the lock and return control to the supervisor UI.

Manual parent starts place that parent ahead of watcher-only candidates but never interrupt active workers. Watch mode polls active parents in `Execute`; it schedules work but does not change a parent to `Build`. A parent transitions to `In Review` only after every child is `Done` and configured integration checks pass.

For a human block, Crosby posts detailed evidence on the child, marks it `In Review`, and leaves unrelated work eligible. Confirmed operator input routes through Herdr to the exact task key; on successful resume, the child returns to `Build`.

A missing/dead agent receives one recorded same-worktree recovery attempt. A second failure moves the child to `In Review`.

### 7. Supervisor interface

Retain existing parent, watch, push, and review operations while adding task-key-targeted controls:

```text
/crosby status [COA-123]
/crosby ask COA-123 <instruction>
/crosby pause <COA-parent|all>
/crosby resume <COA-parent|all>
/crosby stop <COA-123|all>
/crosby cleanup <COA-123|COA-parent>
```

The extension also registers supervisor tools that expose the same operations to normal conversation. Read-only status/inspection is immediate. Stop and cleanup use Pi confirmation UI and show the exact worker/worktree impact first.

Use a compact supervisor widget/status area and concise notifications for meaningful transitions only: launched, blocked, report received, merge pending, merged, review-required, and recovery failure. Full worker detail remains in the task tab.

### 8. Linear reporting

Replace verbose parent rollups with:

- **child issue**: detailed structured report after completion/block/integration outcome;
- **parent issue**: one concise completion/link comment, or one concise human-action/link comment; and
- **parent finalization**: concise state and child links only.

The existing push/review workflow uses the managed parent integration worktree and retains its explicit operator invocation.

## Phased Delivery

### Phase 1 — Contracts, configuration, and test seams

- Extract task contract parsing/validation from queue selection.
- Define project configuration validation and clear missing/invalid recovery output.
- Extend shared `to-issues` and `tasks` requirements/output/checklists for execution metadata.
- Refactor current queue/Linear logic behind injectable operations where needed; preserve legacy sequential behavior.
- Add unit tests for metadata parsing, invalid-scope rejection, overlap matrix, legacy classification, and configuration validation.

**Exit criterion**: no task can be classified as parallel-safe without explicit valid metadata; existing tasks remain sequentially runnable.

### Phase 2 — Durable registry and managed Git isolation

- Implement versioned registry, atomic updates, process lock, and registry migration/version errors.
- Implement managed bare-clone discovery, parent integration worktree, task branch/worktree creation, and cleanup primitives.
- Implement changed-path collection, scope validation, task verification, safe commit, and serialized merge primitives.
- Add temporary-repository tests for clean merge, conflict preservation, out-of-scope rejection, `Verification: none`, cleanup confirmation boundary, and normal-checkout non-mutation.

**Exit criterion**: Crosby can create isolated task workspaces and safely integrate a synthetic completed task without Herdr.

### Phase 3 — Herdr interactive workers and structured reports

- Implement the Herdr adapter with strict response validation and focused fake adapter tests.
- Launch a tab named by child key, start interactive Pi in its root pane, and persist all Herdr identifiers before dispatch completes.
- Register the worker report/block tool and worker bootstrap prompt.
- Wire blocked reporting into Herdr agent lifecycle state and child Linear `In Review` transition.
- Add launch failure rollback, no-headless-fallback, one-recovery-attempt, and restart-reconciliation tests.

**Exit criterion**: a task is visibly interactive, reports explicitly, and survives supervisor replacement without duplicate launch.

### Phase 4 — Global scheduler, integration, and supervisor controls

- Replace blocking `runQueueExecution`/watch execution with scheduler ticks and global capacity accounting.
- Add cross-parent/same-repository scope compatibility, manual-parent priority, pause/resume, and serialized report integration.
- Keep parents in `Execute` throughout active execution.
- Add explicit commands, conversational supervisor tools, compact task tree/status rendering, confirmations, and Herdr prompt routing.
- Update push/review to use managed parent integration state.
- Add deterministic scheduler tests for capacity, priority, blockers, overlapping scopes, out-of-order completion, stale records, and restart adoption.

**Exit criterion**: two eligible tasks can run visibly in parallel; all unsafe/blocked cases remain non-destructive and observable.

### Phase 5 — Linear reporting, documentation, and end-to-end verification

- Implement detailed child reports and concise parent completion/block/final comments.
- Update Crosby README with workflow, controls, recovery, configuration, metadata, migration, and cleanup rules.
- Update quickstart and verify shared-workflow manifest requirements remain accurate.
- Run an end-to-end smoke scenario against a disposable Git repository/fixture and mocked Linear/Herdr adapters, then manually verify a real Herdr tab lifecycle before release.

**Exit criterion**: all spec acceptance criteria have automated coverage where possible and a documented manual Herdr acceptance flow where terminal UI behavior must be observed.

## Testing Strategy

### Unit tests

- command parser compatibility for existing and new `/crosby` forms;
- task-contract parser, scope normalization, overlap detection, and legacy behavior;
- registry schema, atomic recovery, reconciliation decisions, and retry limits;
- worker-report schema and state transitions;
- parent/child comment formatting and comment-size expectations;
- scheduler candidate ordering, two-slot capacity, manual priority, blockers, and same-repo collisions.

### Integration-style tests with fakes

- Herdr launch sequence, response validation, launch rollback, agent recovery, prompt routing, and no-headless-fallback;
- Linear claim/revert/report behavior on every failure boundary;
- temporary Git repositories for branch isolation, scope checks, merges, conflicts, and final integration commands;
- restart reconciliation with registry/Herdr/Linear/Git disagreement fixtures.

### Manual acceptance

- Start a supervisor inside Herdr and verify task tabs are named by issue key without stealing focus.
- Confirm Agents column changes for working, blocked, and idle/report-complete workers.
- Steer a task directly in its tab and confirm scope/integration guardrails still apply.
- Close/restart supervisor and confirm re-adoption rather than duplicate task launch.
- Verify a missing Herdr service reports in the launcher tab with no background worker created.

### Mandatory regression coverage

Retain current Crosby tests for queue classification, worker-result parsing, queue refresh, reporting, explicit push/review, and current mutation failure behavior. Update expectations that intentionally change: parent remains `Execute`, parent comments are concise, and an active `Build` child may be a persisted/adoptable worker rather than an automatic hard stop.

## Rollout and Migration

1. Ship the project configuration requirement and task-metadata guidance with clear recovery messages before enabling parallel dispatch.
2. Treat pre-existing tasks with missing metadata as sequential legacy tasks; never infer parallel eligibility.
3. Keep default concurrency at two through `CROSBY_MAX_WORKERS`, validating positive integers and falling back to two only when unset.
4. Do not auto-clean retained worktrees/tabs during migration.
5. Roll back by pausing the scheduler; persisted worker records and managed worktrees preserve evidence for manual recovery.

## Complexity Tracker

| Decision | Why it is necessary | Rejected simpler option |
|---|---|---|
| External durable registry | Must recover across Pi session and Herdr restart without duplicate execution. | Pi session entries are per-session and cannot act as global scheduler state. |
| Managed bare clone plus worktrees | Guarantees Crosby never writes the operator checkout while allowing a dedicated parent branch workspace. | Reusing the operator clone risks branch/worktree conflicts and accidental mutation. |
| Explicit worker report tool | Herdr lifecycle is not a reliable task-completion signal. | Inferring done from idle/terminal text is ambiguous. |
| Scope metadata and opt-in | Safe parallelism must be decided before launch. | LLM prediction or post-hoc diff cannot prevent concurrent conflicts. |
| Serialized merges | Parallel execution can be safe while parent integration remains ordered and recoverable. | Parallel merges make conflicts and parent state nondeterministic. |

## Checklist Before Tasks

- [x] Feature issue and clean feature worktree created.
- [x] Process-automation routing selected.
- [x] Specification documents the agreed behavior and safety boundaries.
- [x] Research captures Pi, Herdr, Git, and current-Crosby constraints.
- [x] Implementation plan identifies modules, persistence, lifecycle, configuration, and test strategy.
- [ ] User approves the specification/plan.
- [ ] Break approved plan into independently executable Linear child issues.
