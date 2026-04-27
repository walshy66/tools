---
name: grill-me
description: Interview the user relentlessly about a plan or design until every branch of the decision tree is resolved. Use when you want to stress-test a plan, get grilled on a design, or need shared understanding before implementation.
---

# Grill Me

Interview the user relentlessly about a plan or design until shared understanding is reached.

## When to Use

- The user wants to stress-test an idea or plan
- You need to resolve branching design decisions before implementation
- The user asks to be grilled on a proposal
- The plan has ambiguity that should be resolved before coding

## Core Principles

1. Ask one question at a time.
2. Walk the decision tree from the top down.
3. Resolve dependencies between decisions before moving on.
4. For each question, provide your recommended answer.
5. If a question can be answered by exploring the codebase, inspect the codebase instead of asking the user.

## Workflow

### 1) Frame the decision space
- Identify the main design branches
- Find the highest-risk unknowns first
- Decide what must be answered before lower-level choices matter

### 2) Ask one question
- Ask a single focused question
- Include your recommendation and reasoning
- Keep the question concrete and actionable

### 3) Wait for the answer
- Do not batch multiple unrelated questions
- Use the answer to choose the next branch

### 4) Continue until complete
- Keep drilling down until the plan is no longer ambiguous
- Stop when the important branches are resolved

## Output Style

A good grilling loop looks like:

1. Question
2. Recommended answer
3. User response
4. Next question

## Quality Checks

- Did you ask only one question?
- Did you include a recommendation?
- Did you follow the decision tree, not a random list?
- Did you inspect the codebase when the answer could be discovered there?

## Troubleshooting

**Too many questions at once**
- Split them into separate turns.

**The answer is already in the repo**
- Explore the codebase and answer from evidence.

**The plan is still ambiguous**
- Keep drilling down until the ambiguity is removed.
