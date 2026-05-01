## Summary
Define the canonical constitution entrypoint and routing structure for work-type-aware rule selection.

## Type
AFK

## Execution Window
1

## User Stories Covered
- As a workflow owner, I want the agent to apply different constitutional rules to development work vs process-automation work so guidance matches the job being done.
- As a maintainer, I want Core rules to apply everywhere while allowing work-type docs to explicitly add or override rules in a controlled format.

## Acceptance Criteria
- `shared-workflows/references/constitution.md` is defined as the canonical entrypoint.
- The top-level constitution includes **Core**, **Work Type Routing**, and **Selection Algorithm** sections.
- Referenced docs are defined for:
  - `shared-workflows/references/constitution.development.md`
  - `shared-workflows/references/constitution.process-automation.md`
- Override format is explicitly specified via an `Overrides` section.

## Notes
This issue establishes the source-of-truth structure that later skill updates will depend on.
