---
name: handover-idea
description: Extract a concise idea brief from a specific Linear issue that has a description but no attached spec. Use when you want to pull a Linear item into discussion, flesh out the concept, and decide what to build next, while blocking if the issue is not in Spec Creation.
---

# Handover Idea

Turn a Linear issue description into a discussion-ready idea brief.

## When to Use

- The Linear issue has a description but no spec attached
- You want to explore the idea before writing a formal spec
- You want to discuss and refine the shape of the work
- You need the issue key, title, URL, and summary details
- You do **not** want branch creation, file writes, or Linear status updates
- Requires Linear MCP tools to be available in the current session

## Core Principles

1. **MCP prerequisite is mandatory**: only run if the current session exposes `mcp__claude_ai_Linear__*` tools.
2. **Status gate is mandatory**: only retrieve details when the Linear issue is in `Spec Creation`.
3. **Description-first**: use the issue description as the source material; do not require a spec attachment.
4. **Read-only only**: do not create branches, commit files, edit the issue, or transition statuses.
5. **No guessing**: report exactly what Linear shows; do not invent missing details.
6. **Disambiguate safely**: if multiple issues match, ask the user which one to inspect.

## How to Use

```bash
/skill:handover-idea COA-86
```

The skill should:
1. Confirm the current session exposes Linear MCP tools.
2. Use the requested Linear issue key provided by the user.
3. Open that exact issue.
4. Block and return `No` if the issue is not in `Spec Creation`.
5. Extract metadata only after the status check passes.
6. Build an idea brief from the issue description and visible metadata.
7. Return a concise discussion-ready summary.

## Complete Workflow

### 0) Verify Linear MCP access
Before doing anything else, confirm the session has Linear MCP tools available.

Rules:
- If `mcp__claude_ai_Linear__list_issues` / `get_issue` tools are unavailable, stop immediately.
- Return `No` or a blocked message rather than guessing or falling back to web/manual lookup.
- Do not proceed until Linear MCP access is present.

### 1) Find the requested issue
Open the exact Linear issue key provided by the user.

Rules:
- Do not search broadly when an issue key is provided.
- If the issue key cannot be resolved, stop and ask the user for a valid issue key.
- If the issue is found but not in `Spec Creation`, return `No` and stop.

### 2) Verify the status
Before extracting anything else, confirm the issue is exactly in `Spec Creation`.

If the status is anything else, return `No` and block retrieval immediately.

### 3) Extract issue metadata
Capture:
- Issue key
- Issue title
- Issue URL
- Current status
- Assignee
- Priority
- Labels
- Project
- Description summary
- Acceptance criteria, if present
- Linked issues or dependencies, if visible

### 4) Build the idea brief
Use the description to produce a discussion starter with:
- core problem
- likely intent
- open questions
- possible build direction
- missing details to clarify later

Do not create a spec scaffold or write any files.

### 5) Return the idea brief
Present the result in a short, scannable format suitable for a follow-up design or planning conversation.

## Output Format

Use this structure:

```md
# Linear Idea Brief

## Issue
- Key:
- Title:
- URL:
- Status:

## Metadata
- Assignee:
- Priority:
- Labels:
- Project:

## Idea Summary
- Problem:
- Likely intent:
- Open questions:
- Suggested direction:

## Blockers
- None, or explain why retrieval was blocked
```

## Validation and Quality Checks

Before returning the brief, confirm:

- The issue status is exactly `Spec Creation`
- The issue key and title were captured
- The response clearly says it is an idea brief, not a spec brief
- No spec scaffold was created
- No branches were created and Linear status was not changed

## Troubleshooting

**No issues found**
- The issue is not ready yet. Ask the user to move it to `Spec Creation`.

**Multiple issues found**
- List the issue keys and titles and ask the user to choose one.

**Issue is not in Spec Creation**
- Return `No` and stop. Retrieval is blocked until the status matches.

**Linear access fails / MCP missing**
- Tell the user to check Linear MCP availability, authentication, or CLI access.

## Related Skills

- `handover-agent` — Full handoff flow that may create a spec scaffold
- `spec-writer` — Helpful if the user later wants to formalize the idea into a spec
- `small-update` — For making small content updates once work starts
