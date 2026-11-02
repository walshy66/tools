# Crosby for Claude Code

A copy of the Pi Crosby extension (`shared-workflows/pi/extensions/crosby/`) adapted to run under Claude Code inside Herdr. The Pi version is untouched and keeps working; the two share no state.

Crosby executes GitHub parent/child issues through durable, Herdr-visible Claude workers. GitHub remains the execution source of truth, and every gate (contract validation, independent code review, browser testing, revision-bound integration, three-attempt repair limit, combined-parent verification) is enforced by the same code as the Pi version.

## Commands (Claude Code, inside a Herdr pane)

```text
/crosby #129                   run a parent
/crosby resume #129            resume after assistance/interruption
/crosby review #129            same as resume (Pi parity)
/crosby done #129 [#130]       acknowledge manual assistance (Pi: crosby_review_complete)
/crosby push #129              publish the verified parent SHA and PR (explicit only)
/crosby --watch                pick up runnable parents continuously
/reviewer [--base <ref>] [focus]   ad-hoc report-only code review in a sibling pane
```

`/crosby` starts `crosby-cli.mjs` as a background process and relays its `[crosby…]` lines, so the trigger session stays usable. One supervisor per trigger pane; a second run is rejected while one is building, and an idle GitHub queue monitor is replaced by an explicit new run.

Install the commands by copying `commands/crosby.md` and `commands/reviewer.md` to `~/.claude/commands/`. Do not put them in `~/.claude/skills/` (that folder is linked to `portable/skills`, which Pi also loads).

## How it maps from Pi

| Pi | Claude |
|---|---|
| `pi.registerCommand('crosby')` running in-process | `crosby-cli.mjs` supervisor started by `/crosby` |
| `startPiAgent` in Herdr tabs/panes | `startClaudeAgent`: `claude --dangerously-skip-permissions --model … --effort … --mcp-config … --settings …` typed into the pane (Herdr's `agent start --kind claude` cannot launch the npm shim on Windows) |
| `crosby_worker_report` / `crosby_gate_report` tools | `crosby-mcp.mjs` stdio MCP server, one per agent (`prepareClaudeLaunch` writes its context) |
| `tool_call` hooks (builder frozen after report, verifier report-only) | `crosby-hook.mjs` `PreToolUse` hook from the per-agent `--settings` file |
| Model assessment via `pi-ai` | Child issue labels decide: `model:opus`, `model:sonnet`, `model:fable` or a full `claude-*` ID, and `thinking:` → `--effort`. Missing or non-Claude labels use `CROSBY_CLAUDE_DEFAULT_MODEL` (default `opus`). Haiku is always refused. Reviewer/tester overrides: `CROSBY_REVIEWER_MODEL`/`_THINKING`, `CROSBY_TESTER_MODEL`/`_THINKING` |
| State under `~/.pi/crosby` | State under `~/.claude/crosby` (registries, managed sources, worktrees, gate runs, reviews, launch contexts, runs/dashboard) |

`.pi/crosby.json` in the target repository is still the project contract (`finalIntegrationCommands`); it is read, never written.

## Permissions and trust

- Workers run in bypass-permissions mode (operator decision). `skipDangerousModePermissionPrompt` is set only in the per-agent settings file, never globally.
- Claude asks once per repository to trust its folder. For Crosby that is the managed bare repo under `~/.claude/crosby/sources/`; for `/reviewer` it is the reviewed repository. When the dialog appears, the supervisor prints a `[crosby:warning]` naming the pane and waits up to 30 minutes for you to choose "Yes, I trust this folder"; all later worktrees of that repository inherit it.
- Hooks and revision checks are not an OS sandbox; Bash stays available to verifiers for tests and the browser CLI.

## Do not run both harnesses on the same parent

The Pi and Claude versions keep separate registries and run leases, so neither can see the other's in-flight run. Both move the same GitHub issue labels. Run a given parent from one harness at a time.

## Verification

```bash
node --test shared-workflows/claude/crosby/*.test.mjs
```

`claude-adapter.test.mjs` covers model rules, launch wiring, the MCP server and the hook. The copied suites cover contracts, dependencies, gates, repair/recovery, parent verification, report identity and integration. Live smoke tests should use a disposable synthetic repository.
