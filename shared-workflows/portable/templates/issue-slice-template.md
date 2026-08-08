# GitHub Crosby Child Issue

Parent: #<parent-number>

## Outcome

Describe the user or implementation outcome.

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

## File Scope

- `path/to/allowed/file-or-directory`

## Verification

- `command to run`

## Guardrails

- Do not modify out-of-scope files.
- Report a blocked outcome when the contract cannot be satisfied safely.

## Worker Routing Labels

- `model:<provider/model>` sets the worker model when it is available to Crosby.
- `thinking:<off|minimal|low|medium|high|xhigh|max>` sets the Pi thinking level.
- Missing or unavailable labels fall back safely to Crosby defaults.
