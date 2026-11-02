---
description: Crosby for Claude — build, review and browser-test GitHub parent/child issues in Herdr panes; parent stays open for human review
argument-hint: "#parent | resume #parent | review #parent | push #parent | done #parent [#child] | --watch"
allowed-tools: Bash, Monitor, Read
---

Run Crosby (Claude version) with arguments: `$ARGUMENTS`

The Crosby supervisor is `C:/Users/camer/Documents/projects/tools/shared-workflows/claude/crosby/crosby-cli.mjs`. It enforces every gate in code; you only launch it and relay its progress. Never edit issues, worktrees, registries or reports yourself, and never bypass a gate it reports.

1. Crosby must run from this Herdr pane (`HERDR_PANE_ID` set) in the repository checkout that owns the issue. If `$ARGUMENTS` is empty, show the argument hint and stop.
2. `done …` and `push …` are short: run `node "<cli>" $ARGUMENTS` in the foreground (repository cwd) and report its `[crosby…]` lines. `push` publishes; run it only because the operator typed it.
3. Everything else (`#parent`, `resume #parent`, `review #parent`, `--watch`) is long-running supervision:
   - Start `node "<cli>" $ARGUMENTS` with Bash `run_in_background: true` from the repository cwd. Do not wait on it.
   - Arm a Monitor on that task's output file: `tail -n +1 -f "<output file>" | grep --line-buffered "^\[crosby"` with `timeout_ms` 1800000. Re-arm it on expiry while the background task is still running.
   - Relay each event as one short line. Call out `[crosby:warning]` and `[crosby:error]` lines (for example a pane asking to trust the repository, or a blocker with its required action) and repeat the exact action the operator must take.
   - Return control immediately after starting; the operator keeps using this session normally while builders, reviewers and testers work in their own Herdr tabs and the dashboard pane.
4. A second `/crosby` while supervision is running is rejected by the supervisor; relay that rather than retrying. Never kill the supervisor unless the operator asks.
5. When the background task finishes, summarise its final lines: ready for review (parent remains open for manual closure) or not ready (blocker, evidence, assistance needed, `/crosby resume #parent`).
