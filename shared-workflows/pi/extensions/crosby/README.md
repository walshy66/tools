# Crosby

Crosby executes GitHub parent/child issues through durable, Herdr-visible workers. GitHub is the execution source of truth.

## Commands

```text
/crosby #129
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

Completed issues are closed. Automated child bodies must contain `Outcome`, `Acceptance Criteria`, `File Scope`, `Verification`, and `Guardrails`. `model:` and `effort:` labels are advisory hints only; the authenticated parent model selects the final worker model from its allowlisted candidates.

## Herdr layout

The control tab remains interactive. Inside Herdr, it is split top-to-bottom with the live dashboard below it. Each child worker opens in a separate tab labeled `Task #<issue-number>` without stealing focus.

## Safety and recovery

Crosby retains managed parent/task worktrees, durable registry state, explicit `crosby_worker_report` completion, scope validation, declared verification, and serial integration. Worker launch configures environment before prompting. On Windows, Pi uses the shell-native launch path with validated arguments; failed launches retain the tab and evidence for inspection.

Crosby does not automatically push or create a PR during normal execution. Use explicit `push` and `review` commands after the parent is complete.
