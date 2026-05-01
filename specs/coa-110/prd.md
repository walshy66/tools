# PRD: Work-Type-Aware Constitution Routing

## Problem Statement
The current constitution model assumes one general constitution, but the work being done spans two materially different streams: **development** and **process automation/workflow**. These streams need different guardrails. Today, skills may also reference inconsistent constitution locations, which creates ambiguity and makes routing hard to standardize.

A reliable mechanism is needed so agents can apply the **right constitutional rules for the right kind of work** without wasting tokens reading irrelevant material or guessing the intended rule set.

## Solution
Introduce a **single canonical constitution entrypoint** that contains:
- shared **Core** rules
- a **work-type routing table**
- a **selection algorithm** for skills

Then split work-type-specific rules into separate referenced documents, selected by a single authoritative **Linear work-type label** or, for non-Linear hard-gated work, an explicit `Work Type:` prompt header.

This keeps one source of truth while allowing targeted rule application with low token overhead.

## User Stories
1. **As a workflow owner**, I want the agent to apply different constitutional rules to development work vs process-automation work so guidance matches the job being done.
2. **As an agent operator**, I want work type to be selected deterministically from a single authoritative signal so hard-gated skills do not guess.
3. **As a planner/implementer**, I want missing or invalid work-type selection to fail fast with a clear recovery message so I can fix the issue and rerun.
4. **As a user running ad hoc work outside Linear**, I want a simple prompt format that explicitly declares work type so the same routing model still works.
5. **As a maintainer**, I want Core rules to apply everywhere while allowing work-type docs to explicitly add or override rules in a controlled format.

## Implementation Decisions
- Use **one canonical constitution entrypoint**:
  - `shared-workflows/references/constitution.md`
- Top-level constitution contains:
  - Core rules
  - Work Type Routing table
  - Selection Algorithm
- Work-type-specific docs:
  - `shared-workflows/references/constitution.development.md`
  - `shared-workflows/references/constitution.process-automation.md`
- **Linear label is authoritative** for issue-based work
- Valid work-type labels:
  - `wt:development`
  - `wt:process-automation`
- **Hard-gated skills** require exactly one valid work-type selector
- **Discovery/grilling skills** may continue with ambiguity and ask follow-up questions
- If issue content conflicts with the label, **label wins**, but the agent should warn
- For non-Linear hard-gated work, require:
  - `Work Type: development`
  - or `Work Type: process-automation`
- Core always applies
- Work-type docs may:
  - add rules
  - override Core only through an explicit **`Overrides`** section naming the exact Core rule affected
- If a label maps to no valid routing entry/doc, hard-gated skills must block with a configuration error

## Testing Decisions
Verify:
- valid Linear label routes to Core + correct work-type doc
- missing label on hard-gated skill blocks with recovery guidance
- multiple work-type labels block
- label/content mismatch produces warning but proceeds by label
- non-Linear hard-gated work without `Work Type:` header blocks
- non-Linear hard-gated work with valid header routes correctly
- missing routed doc/config blocks immediately
- explicit `Overrides` sections are recognized deterministically
- discovery/grilling skills can continue without selector and ask when needed

## Out of Scope
- Adding more work types beyond the initial two
- Adding a second label axis such as `kind:bug` / `kind:task`
- Standardizing every existing skill’s constitution lookup behavior
- Full migration away from legacy `.specify/memory/constitution.md` references
- Implementation details of Linear label administration

## Further Notes
- Initial implementation order should be:
  1. update constitution doc structure
  2. update skills to use it
- The current skill set appears inconsistent in where it expects constitution material to live; that follow-up should happen after the constitution structure is finalized.
- For common ad hoc website edits, the expected non-Linear work type will usually be `development`, but the explicit header should still be required for hard-gated skills.
