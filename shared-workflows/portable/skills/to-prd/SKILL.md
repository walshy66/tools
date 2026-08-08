---
name: to-prd
description: Turn the current conversation context into an approved PRD and publish it as a GitHub parent issue. Use at the end of a settled design or grilling session when the product brief is ready to become the execution parent.
---

# To PRD

Synthesize the current context into a focused PRD that a developer or agent can execute against.

## When to Use

- A feature has been discussed and needs a written PRD
- You want to convert conversation context into a durable brief
- The user wants planning before implementation
- You need a reusable product document that is tool-neutral

## Core Principles

1. Synthesize from existing context; do not re-interview unless a critical gap blocks progress.
2. Write the PRD around user outcomes, not implementation trivia.
3. Keep the document specific enough to guide design and planning.
4. Include testable user stories and clear out-of-scope boundaries.
5. The approved PRD becomes the durable GitHub parent issue for execution.
6. Never create or modify a GitHub issue before explicit user approval.

## Workflow

### 1) Gather context
- Read the current conversation
- Inspect the codebase if needed for constraints or patterns
- Identify the user problem and the desired outcome

### 2) Define the problem and solution
- State the user-facing problem
- Describe the intended solution at a product level

### 3) Write user stories
- List the primary journeys in priority order
- Make each story independently understandable
- Keep the stories framed in user value language

### 4) Capture implementation decisions
- Note the major modules, interfaces, or contracts that matter
- Keep this at a decision level, not a code-path level

### 5) Capture testing decisions
- Describe the behaviors that should be verified
- Call out important success and failure cases

### 6) Mark out of scope
- Define what is intentionally not being solved now

### 7) Review and publish the parent issue
- Present the complete PRD to the user for review.
- Wait for explicit approval before contacting GitHub or creating an issue.
- After approval, determine the current repository with `gh repo view --json nameWithOwner`.
- Create one GitHub parent issue whose title summarizes the feature and whose body is the approved PRD.
- Apply these labels:
  - `type:parent`
  - `status:ready`
  - the appropriate work-type label, such as `wt:development` or `wt:process-automation`
- Run `scripts/bootstrap-github-labels.sh` first when required labels are missing; label setup must be idempotent.
- Include a `## Child Issues` placeholder in the parent body for `to-issues` to populate.
- If the user supplied an existing parent issue instead, do not create a duplicate; report that issue and use it as the handoff target.
- Return the parent issue number and URL so the user can invoke `to-issues` against it.

Example after approval:

```bash
gh issue create \
  --title "<feature title>" \
  --body "$(cat prd.md)\n\n## Child Issues\n\n<!-- to-issues will populate this checklist. -->" \
  --label "type:parent,status:ready,wt:development"
```

## Output Format

Use a PRD with these sections:

- Problem Statement
- Solution
- User Stories
- Implementation Decisions
- Testing Decisions
- Out of Scope
- Further Notes
- GitHub Parent Issue (after approval): number, URL, and applied labels

## Quality Checks

- Does the PRD explain the user problem clearly?
- Are the stories ordered by priority and value?
- Are the decisions specific enough to guide design?
- Is the scope boundary explicit?
- Would another tool or person understand what comes next?
- Was the GitHub parent issue withheld until explicit approval?
- Does the published parent contain the approved PRD and a child-issue placeholder?

## Troubleshooting

**Context is incomplete**
- Ask one focused question instead of guessing.

**The PRD is too vague**
- Tighten the user stories and decisions.

**The PRD is too technical**
- Remove implementation details and keep the product level view.

**GitHub issue creation is not approved**
- Do not run `gh issue create`; leave the PRD available for revision.

**GitHub parent creation fails**
- Report the `gh` error and do not claim the parent was created. Check GitHub CLI installation, authentication, repository detection, and label availability.
