# Duplicate Skill/Agent Collation

This report groups the overlapping skill/agent functions across your current implementations so you can decide what to keep, rename, or remove.

## Current locations scanned

- Pi: `C:\Users\camer\.pi\agent\skills\*` and `C:\Users\camer\.pi\agent\extensions\*`
- Claude Code: `C:\Users\camer\.claude\agents\*`
- Codex: `C:\Users\camer\.codex\*` (no matching skill/agent content found)
- Shared repo: `C:\Users\camer\Documents\projects\tools\shared-workflows\*`

## Summary

- **Exact name overlaps between Pi and Claude Code**: 10
- **Already centralised in shared repo**: 5
- **Unique to Pi**: 1 skill (`firecrawl`)
- **No overlapping agent/skill content found in Codex**

## Already centralised in shared repo

These are present in `shared-workflows/portable/skills/`:

| Skill | Shared repo | Pi | Claude Code | Notes |
|---|---:|---:|---:|---|
| `tdd` | ✅ | ✅ | ❌ | Portable skill created centrally |
| `to-prd` | ✅ | ✅ | ❌ | Portable skill created centrally |
| `to-issues` | ✅ | ✅ | ❌ | Portable skill created centrally |
| `grill-me` | ✅ | ✅ | ❌ | Portable skill created centrally |
| `git-guardrails-claude-code` | ✅ | ✅ | ❌ | Portable skill created centrally |

## Exact-name overlaps across Pi and Claude Code

These names exist in both tool implementations, but the wording and workflow differ in some cases.

| Name | Pi path | Claude path | Same function? | Key difference |
|---|---|---|---|---|
| `analyze` | `.pi/agent/skills/analyze/SKILL.md` | `.claude/agents/analyze.agent.md` | Yes | Pi skill audits a spec after design; Claude agent also audits a spec but is framed as an agent workflow |
| `clarify` | `.pi/agent/skills/clarify/SKILL.md` | `.claude/agents/clarify.agent.md` | Yes | Both improve specs; Claude agent is more explicitly an applied workflow |
| `code-reviewer` | `.pi/agent/skills/code-reviewer/SKILL.md` | `.claude/agents/code-reviewer.agent.md` | Yes | Both review implementation against spec/plan/tasks; wording differs slightly |
| `design-reviewer` | `.pi/agent/skills/design-reviewer/SKILL.md` | `.claude/agents/design-reviewer.agent.md` | Yes | Same review function; Claude version says it reviews a Gemini-written spec |
| `design` | `.pi/agent/skills/design/SKILL.md` | `.claude/agents/design.agent.md` | **Similar, not identical** | Pi version enhances an existing spec; Claude version writes a full spec from FEATURE.md and codebase context |
| `handover` | `.pi/agent/skills/handover/SKILL.md` | `.claude/agents/handover.agent.md` | **Similar, not identical** | Pi version fetches Linear issues marked Handover; Claude version fetches from Notion and creates FEATURE.md |
| `implement` | `.pi/agent/skills/implement/SKILL.md` | `.claude/agents/implement.agent.md` | Yes | Both execute implementation with execution windows and state tracking |
| `plan` | `.pi/agent/skills/plan/SKILL.md` | `.claude/agents/plan.agent.md` | Yes | Both create implementation plans after design/analyze/clarify |
| `specify` | `.pi/agent/skills/specify/SKILL.md` | `.claude/agents/specify.agent.md` | Yes | Both initialize a new feature with structure and git setup |
| `tasks` | `.pi/agent/skills/tasks/SKILL.md` | `.claude/agents/tasks.agent.md` | Yes | Both break a plan into execution-window tasks |

## Unique to Pi

| Name | Path | Notes |
|---|---|---|
| `firecrawl` | `.pi/agent/skills/firecrawl/SKILL.md` | No matching Claude Code agent found |

## Shared repo note

The shared repo currently holds portable versions of these skills:

- `tdd`
- `to-prd`
- `to-issues`
- `grill-me`
- `git-guardrails-claude-code`

The lifecycle workflow items (`analyze`, `clarify`, `design`, `handover`, `implement`, `plan`, `specify`, `tasks`, `code-reviewer`, `design-reviewer`) still exist primarily as tool-specific implementations.

## Recommended decision points

### Keep one canonical version when the behavior is the same
Best candidates to deduplicate into the shared repo and treat as canonical:

- `tdd`
- `to-prd`
- `to-issues`
- `grill-me`
- `git-guardrails-claude-code`
- likely `analyze`
- likely `clarify`
- likely `code-reviewer`
- likely `design-reviewer`
- likely `implement`
- likely `plan`
- likely `specify`
- likely `tasks`

### Review before removing
These have the same name but are not identical in intent/workflow:

- `design`
- `handover`

For these, decide whether to:
1. keep one canonical workflow and adapt the others to it,
2. rename the tool-specific version, or
3. preserve both because they intentionally do different jobs.

### Safe removal candidate
- None should be deleted yet until you choose a canonical source for each overlapping function.

## Suggested cleanup order

1. Decide the canonical source for each overlapping name.
2. Move the canonical content into `shared-workflows/portable/`.
3. Replace tool-local copies with thin pointers or adapters.
4. Remove any local copies that are redundant after the move.
5. Keep Pi-only runtime behavior in `shared-workflows/pi/extensions/`.

## Quick reading guide

If you want to review the highest-impact collisions first, start with:

1. `design`
2. `handover`
3. `implement`
4. `plan`
5. `specify`
6. `tasks`
7. `analyze`
8. `clarify`
9. `code-reviewer`
10. `design-reviewer`

These are the items most likely to benefit from a single canonical source.
