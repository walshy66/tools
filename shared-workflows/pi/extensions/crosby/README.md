# Crosby

Crosby executes GitHub parent/child issues through durable, Herdr-visible workers. GitHub is the execution source of truth.

## Commands

```text
/crosby #129
/crosby resume #129
/crosby --watch
/crosby push #129
/crosby review #129
```

Run from the repository checkout that owns the issue. Crosby compares the checkout's `origin` URL with the GitHub issue repository and fails closed on a mismatch. No folder-routing label is required.

## GitHub contract

Required labels are bootstrapped with `scripts/bootstrap-github-labels.sh`:

- `type:parent`, `type:child`
- `status:ready`, `status:execute`, `status:ready-to-build`, `status:building`, `status:review`
- `mode:afk`, `mode:hitl`
- `wt:development`, `wt:process-automation`

Completed **children** are closed after verified integration. The parent remains open in `status:review` for the operator's final experience/taste review and manual closure. A partial or blocked build is explicitly **not ready for review**, with the reason, affected issue, evidence, required assistance, and resume action.

Child bodies retain `Outcome`, `Acceptance Criteria`, `File Scope`, `Verification`, and `Guardrails`, and also require:

- `Review Context`: repository rules/approved decisions, parent reference, scope/non-goals and required coverage.
- `Dependencies`: explicit prerequisite `#issue` IDs within the parent build, or `None`. Forward references are ordered; unknown/self/cyclic dependencies block affected tasks. List order does not invent dependencies.
- `Browser Acceptance`: exactly `Browser testing: required` or `Browser testing: not applicable`. The latter requires a concrete reason; missing tooling/accounts is a blocker, not an exemption. Required `### PW-01: ...` scenarios link known AC IDs and include Preconditions/test data, User actions, and Expected outcomes.

Use the canonical `to-issues` skill/template. Browser steps must never be placed in command-only `Verification`. Malformed/legacy contracts block explicitly; Crosby does not invent acceptance criteria or silently skip a missing declaration. Update existing issues through an approved contract-migration step before resuming. Legacy closed automated issues without durable completion evidence also require explicit reconciliation rather than being trusted or rebuilt automatically.

Parent issues need `Review Context`, identified `Acceptance Criteria`, and `Browser Acceptance` for the combined deliverable (explicitly not applicable with reason when no cross-issue browser journey applies). Existing PRDs without those sections need an approved addition; the `to-prd` skill itself is unchanged.

`model:` and `thinking:` labels set builder launch settings when valid; unavailable labels fall back to the authenticated parent's allowlisted candidates. Optional `CROSBY_REVIEWER_MODEL`/`CROSBY_REVIEWER_THINKING` and `CROSBY_TESTER_MODEL`/`CROSBY_TESTER_THINKING` configure verifier routing through the same available-model assessment. Fresh context is mandatory, a different provider is not.

## Herdr layout

The control tab remains interactive: `/crosby` schedules session-owned background supervision and returns immediately, so normal prompts are processed while builders/reviewers/testers work. A second Crosby invocation in the same session is rejected while supervision is running rather than creating a duplicate run. After settlement, an explicit invocation drains/stops the previous idle queue monitor before replacing it. Errors remain visible; returning from the command is not build completion. Session shutdown/reload aborts supervision and suppresses late completion notices; it does not kill retained worker panes or waive verification. Reload/restart the trigger session to load a runtime fix, then explicitly resume the retained parent when workers are safely settled; do not start a duplicate pilot. Inside Herdr, the first run opens a live dashboard to the right of the trigger pane. Reruns from that trigger pane reuse the dashboard and switch it to the latest run without restarting its renderer or stealing focus. The pane binding persists across Pi reloads/restarts; a confirmed closed pane is replaced. Dashboards opened before pane reuse was introduced are not automatically adopted and can be closed manually. Each child worker opens in a separate tab labeled `Crosby #<issue-number>` without stealing focus. Independent reviewer and tester agents start in fresh sibling panes within that tab; repairs trigger fresh verifier contexts, not the builder reviewing its own conversation. The completed-parent gates use a parent-labelled tab. Panes and worktrees are retained for inspection.

The control terminal shows deduplicated, bounded one-line transitions. The adjacent dashboard and durable records retain the full queue, gate stages, findings, recovery actions, and evidence. Windows startup acknowledges prompt submission, including one Enter recovery for a prompt left in the editor; it never retransmits the prompt.

## Safety and recovery

Crosby retains managed parent/task worktrees, durable registry state, explicit `crosby_worker_report` completion, scope validation, declared verification, and serial integration. Worker launch configures environment before prompting. On Windows, Pi uses the shell-native launch path with validated arguments; failed launches retain the tab and evidence for inspection.

Crosby does not automatically push, create a PR, deploy, or close a parent. Explicit `push` requires current parent/child contract fingerprints and revision-bound parent approval, and publishes the verified SHA from the retained parent worktree. `review #parent` now resumes the enforced review flow; it does not invoke the old Claude auto-fix PR prompt.

## Enforced gates and repair policy

```text
Validate contract/dependencies → builder completion
  → independent code-reviewer (safe repository checks + architecture)
  → independent tester when required
  → validate exact revision/contracts/evidence → integrate verified SHA → close child
All children complete → combined-parent verification → ready for operator review
```

The reviewer inspects repository commands and prerequisites before executing; Crosby does not blindly rerun potentially destructive shell commands during integration. Missing/failed/stale reports, skipped required commands, missing browser scenarios, unsettled verifiers, or implementation mutation prevent integration. No manual-completion or resume shortcut bypasses these gates.

- **Three automatic repair attempts per child**, persisted and shared across code-review, browser, and attributable parent-integration defects. Initial implementation is not a repair attempt. Resume does not reset the budget.
- Only concrete, in-scope defects go back to the builder. Scope/requirement decisions, permissions, unsafe/missing infrastructure and exhausted attempts require explicit assistance.
- Parent defects with explicit child-scope attribution return to that child, advance its retained worktree to the parent with a clean fast-forward-only operation, and rerun child and parent gates. Ambiguous/cross-cutting failures are blocked for diagnosis, not assigned speculatively.
- Sequential execution skips waiting tasks to run independent tasks; dependents cannot start until prerequisites are completed.

## Repository setup (required before a real run)

The target repository supplies its own constitution, applicable AGENTS.md hierarchy, approved decisions and testing documentation. No shared product constitution is selected automatically.

The committed `.pi/crosby.json` must contain version `1` and a non-empty ordered `finalIntegrationCommands` array of **existing repository commands**. Do not put credentials in configuration or use `none` to waive parent integration. Its commands are inspected by the independent parent reviewer under the repository's documented safety contract, not executed blindly by the scheduler.

Testing documentation must define:

- startup, readiness and how frontend/backend provenance identifies the tested revision;
- authorised isolated databases, fixture ownership, setup/cleanup and command side effects;
- synthetic roles/accounts, approved origins and protection against real external writes;
- Playwright CLI/browser provisioning and any required existing Playwright Test commands;
- how the operator accesses or starts the completed parent for review, and ownership/shutdown of any retained environment.

Do not provision a database, delete a volume, attach a personal browser, install tooling, or invoke real connectors merely because a command needs them. Missing safe prerequisites produce an actionable blocker. This runtime change does not provision Caylios's browser environment or modify its GitHub issues.

## Resume and manual work

Use `/crosby resume #parent` after resolving assistance requests, cancellation/interruption, or a Pi restart. Durable registry discovery preserves the run across Herdr workspaces; conflicting matching registries fail closed rather than choosing one. A parent-scoped run lease prevents concurrent orchestrators. A stale live-process lease requires operator inspection; retained work is not discarded.

While the initiating session remains active, GitHub contract/status changes can resume waiting work. `crosby_review_complete` acknowledges the operator's manual action; supply the child issue when several await assistance. Pure HITL prerequisites may complete, but code-bearing work still goes through its required gates. Final parent closure is always manual. A dependency blocker must be resolved at its prerequisite, not approved away on the dependent.

Reports and evidence live under `~/.pi/crosby/gate-runs/<run-id>/`; task/parent gate history and repair counts live in the durable registry. Report artifacts are validated for assigned-pane receipts and content hashes. Reports are not promises about unobserved backend behaviour.

**Isolation limit:** verifier tool hooks block direct implementation edits and unrelated management tools; builder tools freeze after reporting. Browser/test execution still needs a shell. These hooks and clean-revision checks are not an OS sandbox against arbitrary shell access. Use genuinely isolated accounts/environments; no unrestricted production access is implied.

## Verification

```bash
node --test shared-workflows/pi/extensions/crosby/*.test.mjs
```

Tests cover contract propagation, explicit dependencies, review/test gates, three-attempt repair/recovery, parent verification, report identity/evidence, immutable-SHA integration, and Herdr/UI adapters. Live smoke testing should use a disposable synthetic repository and never real client data.
