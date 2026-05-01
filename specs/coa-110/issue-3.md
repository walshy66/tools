## Summary
Update shared skills to use the canonical constitution routing entrypoint and enforce the new selector rules.

## Type
AFK

## Blocked By
- COA-110 child issue: Define canonical constitution routing structure
- COA-110 child issue: Define work-type rules and selector behavior

## Execution Window
2

## User Stories Covered
- As an agent operator, I want work type to be selected deterministically from a single authoritative signal so hard-gated skills do not guess.
- As a planner/implementer, I want missing or invalid work-type selection to fail fast with a clear recovery message so I can fix the issue and rerun.
- As a user running ad hoc work outside Linear, I want a simple prompt format that explicitly declares work type so the same routing model still works.

## Acceptance Criteria
- Shared skills use the canonical constitution entrypoint consistently.
- Hard-gated skills enforce selector requirements.
- Discovery/grilling skills allow ambiguity and ask when needed.
- Warning behavior for label/content mismatch is implemented or documented.
- Legacy `.specify/memory/constitution.md` reliance is removed or clearly deprecated in shared skills.
