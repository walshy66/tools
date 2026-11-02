---
description: Open an independent, report-only Claude code reviewer in a sibling Herdr pane for the current branch
argument-hint: "[--base <ref>] [focus text]"
allowed-tools: Bash, Monitor, Read
---

Start an ad-hoc Crosby code review with arguments: `$ARGUMENTS`

1. Run from this Herdr pane inside the git repository to review. The reviewer covers `--base <ref>` (default: merge-base with `origin/HEAD`) to HEAD plus any uncommitted changes; remaining arguments are the operator's focus.
2. Start `node "C:/Users/camer/Documents/projects/tools/shared-workflows/claude/crosby/crosby-cli.mjs" reviewer $ARGUMENTS` with Bash `run_in_background: true` from the repository cwd, then return control; do not review the code yourself.
3. Its first line names the reviewer pane. If a `[crosby:warning]` line says the pane is asking to trust the repository, tell the operator to answer it in that pane.
4. When the background task finishes, relay the outcome (passed / changes-required / blocked), the summary, any required action and the report path. Read the report and list its findings briefly. The reviewer pane stays open for follow-up questions there; do not act on findings unless the operator asks.
