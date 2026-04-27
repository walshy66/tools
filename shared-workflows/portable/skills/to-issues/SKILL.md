---
name: to-issues
description: Break a plan, spec, or PRD into independently grabbable issues. Use when you need vertical slices, implementation tickets, or a clean execution sequence from higher-level planning.
---

# To Issues

Convert a plan or PRD into thin, vertical-slice issues that can be worked independently.

## When to Use

- A PRD or spec needs execution tickets
- You want small, independently testable slices of work
- You need dependencies made explicit
- You want to avoid horizontal, layer-by-layer issue breakdowns

## Core Principles

1. Prefer vertical slices that cut through the full stack.
2. Each issue should deliver a narrow, complete outcome.
3. Keep blocker relationships explicit.
4. Separate human-decision slices from buildable slices.
5. Prefer many thin issues over a few thick ones.

## Workflow

### 1) Gather the source material
- Read the plan, spec, or PRD
- Identify the user stories and the minimum viable outcome

### 2) Draft slices
- Break the work into independent vertical slices
- Ensure each issue can be understood and tested alone
- Label blocking dependencies clearly

### 3) Review with the user
- Ask whether the granularity feels right
- Ask whether dependencies are correct
- Ask whether any slices should be merged or split

### 4) Finalize the issue list
- Present the issue titles in dependency order
- Include the acceptance criteria for each issue

## Output Format

Use a numbered list where each issue includes:

- Title
- Type: HITL or AFK
- Blocked by
- User stories covered
- Acceptance criteria

## Quality Checks

- Is each issue independently valuable?
- Does each issue deliver a complete vertical slice?
- Are blockers minimal and realistic?
- Would the issue list support incremental delivery?

## Troubleshooting

**Slices are too coarse**
- Split the work further by user value or capability.

**Slices are too thin to be useful**
- Merge slices until each one still delivers a complete behavior.

**Dependencies are unclear**
- Reorder the list and make blockers explicit.
