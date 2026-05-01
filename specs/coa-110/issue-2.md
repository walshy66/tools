## Summary
Define the initial work-type-specific constitutional rules and the selector behavior for both Linear and non-Linear work.

## Type
AFK

## Blocked By
- COA-110 child issue: Define canonical constitution routing structure

## Execution Window
1

## User Stories Covered
- As a workflow owner, I want the agent to apply different constitutional rules to development work vs process-automation work so guidance matches the job being done.
- As an agent operator, I want work type to be selected deterministically from a single authoritative signal so hard-gated skills do not guess.
- As a planner/implementer, I want missing or invalid work-type selection to fail fast with a clear recovery message so I can fix the issue and rerun.
- As a user running ad hoc work outside Linear, I want a simple prompt format that explicitly declares work type so the same routing model still works.
- As a maintainer, I want Core rules to apply everywhere while allowing work-type docs to explicitly add or override rules in a controlled format.

## Acceptance Criteria
- Development-specific constitution doc exists.
- Process-automation-specific constitution doc exists.
- Both docs clearly state additive rules.
- Any override uses the explicit override format.
- Core applicability is documented consistently.
- Valid Linear labels are documented:
  - `wt:development`
  - `wt:process-automation`
- Hard-gated behavior is defined for:
  - missing label
  - multiple labels
  - missing mapped doc
  - label/content mismatch
- Non-Linear hard-gated prompt format is documented:
  - `Work Type: development`
  - `Work Type: process-automation`
