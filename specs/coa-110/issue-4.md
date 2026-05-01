## Summary
Validate the constitution routing model with regression coverage or equivalent documented verification.

## Type
AFK

## Blocked By
- COA-110 child issue: Update shared skills to use constitution routing entrypoint

## Execution Window
2

## User Stories Covered
- As an agent operator, I want work type to be selected deterministically from a single authoritative signal so hard-gated skills do not guess.
- As a planner/implementer, I want missing or invalid work-type selection to fail fast with a clear recovery message so I can fix the issue and rerun.
- As a user running ad hoc work outside Linear, I want a simple prompt format that explicitly declares work type so the same routing model still works.
- As a maintainer, I want Core rules to apply everywhere while allowing work-type docs to explicitly add or override rules in a controlled format.

## Acceptance Criteria
- Tests or documented validation cover valid label routing.
- Tests or documented validation cover missing label blocking.
- Tests or documented validation cover multiple label blocking.
- Tests or documented validation cover missing mapped doc blocking.
- Tests or documented validation cover mismatch warning with label precedence.
- Tests or documented validation cover non-Linear prompt header enforcement.
- Tests or documented validation cover explicit override handling.
