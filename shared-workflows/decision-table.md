# Duplicate Skill / Agent Decision Table

Use this table to decide what to keep, remove, rename, or centralize for each overlapping function across Pi, Claude Code, and the shared repo.

## Legend

- **Keep**: retain as-is in the current tool-specific location
- **Centralize**: move to `shared-workflows/portable/` as the canonical version
- **Wrap**: keep a thin tool-specific wrapper that points to the shared canonical content
- **Rename**: change the tool-specific name to avoid collision or clarify scope
- **Remove**: delete only after the canonical replacement is in place and verified

## Decision Table

| Name | Pi version | Claude version | Current status | Recommended action | Notes |
|---|---|---|---|---|---|
| `tdd` | Exists | Not found | Already centralized | **Keep + Centralize** | Shared canonical version exists in `shared-workflows/portable/skills/tdd/` |
| `to-prd` | Exists | Not found | Already centralized | **Keep + Centralize** | Shared canonical version exists in `shared-workflows/portable/skills/to-prd/` |
| `to-issues` | Exists | Not found | Already centralized | **Keep + Centralize** | Shared canonical version exists in `shared-workflows/portable/skills/to-issues/` |
| `grill-me` | Exists | Not found | Already centralized | **Keep + Centralize** | Shared canonical version exists in `shared-workflows/portable/skills/grill-me/` |
| `git-guardrails-claude-code` | Exists | Not found | Already centralized | **Keep + Centralize** | Shared canonical version exists in `shared-workflows/portable/skills/git-guardrails-claude-code/` |
| `analyze` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Canonical version now lives in shared repo; decide whether to leave wrappers or delete tool-local copies |
| `clarify` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Canonical version now lives in shared repo; decide whether to leave wrappers or delete tool-local copies |
| `code-reviewer` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Canonical version now lives in shared repo; decide whether to leave wrappers or delete tool-local copies |
| `design-reviewer` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Canonical version now lives in shared repo; decide whether to leave wrappers or delete tool-local copies |
| `design` | Canonical in repo | Exists locally in Pi + Claude | Pi version is canonical; Claude version is legacy workflow | **Keep Pi canonical, retire Claude copy** | Pi enhances an existing spec; Claude design was only needed when the workflow started from FEATURE.md and is no longer needed |
| `handover` | Canonical in repo | Exists locally in Pi + Claude | Pi version is canonical; Claude version is legacy Notion workflow | **Keep Pi canonical, retire Claude copy** | Pi fetches Linear issues; Claude copy was created for a Notion-based workflow and should be retired |
| `implement` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Same execution-window implementation workflow; strong centralization candidate |
| `plan` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Same planning workflow; good centralization candidate |
| `specify` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Same project initialization workflow; good centralization candidate |
| `tasks` | Canonical in repo | Exists locally in Pi + Claude | Canonical source chosen | **Keep canonical, remove duplicates later** | Same task-splitting workflow; good centralization candidate |
| `firecrawl` | Exists | Not found | Unique to Pi | **Keep** | Pi-specific integration; no duplication found in Claude Code |

## Suggested Priority Order

1. **Already centralized skills**: keep those as the baseline.
2. **High-confidence overlaps**: `analyze`, `clarify`, `code-reviewer`, `design-reviewer`, `implement`, `plan`, `specify`, `tasks`
3. **Needs design review**: `design`, `handover`
4. **Unique Pi integration**: `firecrawl`

## Suggested Cleanup Plan

### Phase 1 — Confirm canonical names
Decide whether each overlapping function keeps the current name or gets a new canonical name.

### Phase 2 — Create shared canonical content
Move the chosen canonical versions into `shared-workflows/portable/`.

### Phase 3 — Add tool-specific wrappers
Replace tool-local copies with thin pointers, docs, or adapters that reference the shared canonical source.

### Phase 4 — Remove redundant copies
Delete local duplicates only after the shared canonical version is verified in each tool.

## Open Questions

- Should `design` and `handover` keep their current names, or should one be renamed to reflect its different input source?
- Do you want all lifecycle workflow items to be fully centralized, or only the shared ones that are already nearly identical?
- Should Pi/Claude Code use the shared repo directly, or should they each keep a tiny local index that points to the shared manifest?
