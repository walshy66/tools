---
name: git-guardrails-claude-code
description: Set up safety guardrails for dangerous git commands. Use when you want to block destructive operations such as push, reset --hard, clean, or force delete before they execute.
---

# Git Guardrails

Add guardrails so dangerous git commands are blocked before execution.

## When to Use

- You want to reduce the risk of destructive git operations
- You need to block force push, hard reset, clean, or branch deletion
- You are setting up safety hooks in an agent environment
- You want the guardrails to be reusable across projects

## Core Principles

1. Block dangerous operations before they execute.
2. Make the blocked command and reason clear to the user.
3. Keep the command policy configurable.
4. Preserve safe git operations.
5. Treat the guardrail as a safety layer, not a workflow replacement.

## What to Block

Typical commands to block include:

- `git push` variants that force or overwrite history
- `git reset --hard`
- `git clean -f` variants
- `git branch -D`
- `git checkout .` or `git restore .` when they would discard local changes

## Workflow

### 1) Define scope
- Decide whether the guardrail applies locally or globally
- Confirm whether the current environment supports hooks or command interception

### 2) Install the hook or interceptor
- Wire the guardrail into the tool’s pre-execution mechanism
- Keep the logic in a reusable script or policy file where possible

### 3) Verify behavior
- Attempt a blocked command
- Confirm it is intercepted with a clear message
- Confirm safe commands still work

### 4) Maintain the policy
- Add or remove blocked patterns as needed
- Keep the policy versioned with the shared library

## Output Format

A working guardrail provides:

- a block decision for unsafe git commands
- a clear message explaining why the command was blocked
- a safe allow path for non-destructive git operations

## Quality Checks

- Are destructive commands blocked consistently?
- Is the user told what happened and why?
- Are normal git operations left alone?
- Is the rule set documented and easy to update?

## Troubleshooting

**Too many commands are blocked**
- Narrow the pattern matching.

**A destructive command slipped through**
- Add the missing command pattern and retest.

**The environment has no hook mechanism**
- Use an adapter layer for that tool and keep the policy portable.
