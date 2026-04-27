# Local File Removal Audit

Goal: identify which remaining local files are real runtime-only assets, which are redundant duplicates of the shared repo, and which should be deleted only after the shared manifest is proven in use.

## Summary

- **Canonical shared repo**: `C:\Users\camer\Documents\projects\tools\shared-workflows\manifest.json`
- **Direct manifest access**: chosen
- **Pi handover/design**: canonical in shared repo
- **Claude handover/design**: already retired and deleted

## Classification Legend

- **Delete candidate**: duplicate content that should go away once the manifest-driven load path is working
- **Keep runtime-only**: tool-specific runtime asset that is not a duplicate of the shared repo
- **Keep pointer**: a lightweight startup pointer such as `AGENTS.md`

## Pi (`C:\Users\camer\.pi\agent`)

### Keep pointer

| File | Why |
|---|---|
| `AGENTS.md` | Points Pi at the canonical shared manifest |

### Delete candidate / replace with manifest-driven loading

These are duplicate skill implementations now centralized in the shared repo:

| File | Shared repo counterpart | Notes |
|---|---|---|
| `skills/analyze/SKILL.md` | `shared-workflows/portable/skills/analyze/SKILL.md` | Same workflow family; shared repo is canonical |
| `skills/clarify/SKILL.md` | `shared-workflows/portable/skills/clarify/SKILL.md` | Same workflow family; shared repo is canonical |
| `skills/code-reviewer/SKILL.md` | `shared-workflows/portable/skills/code-reviewer/SKILL.md` | Same workflow family; shared repo is canonical |
| `skills/design-reviewer/SKILL.md` | `shared-workflows/portable/skills/design-reviewer/SKILL.md` | Same workflow family; shared repo is canonical |
| `skills/design/SKILL.md` | `shared-workflows/portable/skills/design/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/handover/SKILL.md` | `shared-workflows/portable/skills/handover/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/implement/SKILL.md` | `shared-workflows/portable/skills/implement/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/plan/SKILL.md` | `shared-workflows/portable/skills/plan/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/specify/SKILL.md` | `shared-workflows/portable/skills/specify/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/tasks/SKILL.md` | `shared-workflows/portable/skills/tasks/SKILL.md` | Pi canonical version now lives in the shared repo |
| `skills/grill-me/SKILL.md` | `shared-workflows/portable/skills/grill-me/SKILL.md` | Shared repo canonical version exists |

### Keep runtime-only

| File | Why |
|---|---|
| `skills/firecrawl/SKILL.md` | Pi-specific integration; no shared portable equivalent identified |
| `extensions/full-status.ts` | Runtime extension, not a portable skill |
| `extensions/simple-status.ts` | Runtime extension, not a portable skill |
| `extensions/task-model-router.ts` | Runtime extension, not a portable skill |
| `extensions/task-presets.ts` | Runtime extension, not a portable skill |
| `extensions/web-search.ts` | Runtime extension, not a portable skill |

## Claude Code (`C:\Users\camer\.claude`)

### Keep pointer

| File | Why |
|---|---|
| `AGENTS.md` | Points Claude Code at the canonical shared manifest |

### Delete candidate / replace with manifest-driven loading

At this point, Claude’s retired `handover` and `design` files are already removed. The remaining local agent files are duplicates of shared canonical workflows:

| File | Shared repo counterpart | Notes |
|---|---|---|
| `agents/analyze.agent.md` | `shared-workflows/portable/skills/analyze/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/clarify.agent.md` | `shared-workflows/portable/skills/clarify/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/code-reviewer.agent.md` | `shared-workflows/portable/skills/code-reviewer/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/design-reviewer.agent.md` | `shared-workflows/portable/skills/design-reviewer/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/implement.agent.md` | `shared-workflows/portable/skills/implement/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/plan.agent.md` | `shared-workflows/portable/skills/plan/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/specify.agent.md` | `shared-workflows/portable/skills/specify/SKILL.md` | Legacy local copy; shared repo is canonical |
| `agents/tasks.agent.md` | `shared-workflows/portable/skills/tasks/SKILL.md` | Legacy local copy; shared repo is canonical |

### Already removed

| File | Status |
|---|---|
| `agents/handover.agent.md` | Deleted |
| `agents/design.agent.md` | Deleted |

## Codex (`C:\Users\camer\.codex`)

### Keep pointer

| File | Why |
|---|---|
| `AGENTS.md` | Points Codex at the canonical shared manifest |

### Keep runtime-only

| File | Why |
|---|---|
| `skills/codex-primary-runtime/slides/SKILL.md` | Codex-specific runtime skill; not a duplicate of the shared portable repo |
| `skills/codex-primary-runtime/spreadsheets/SKILL.md` | Codex-specific runtime skill; not a duplicate of the shared portable repo |
| `skills/codex-primary-runtime/spreadsheets/style_guidelines.md` | Codex-specific support doc |
| `skills/codex-primary-runtime/spreadsheets/templates/financial_models.md` | Codex-specific support template |

## Recommended next removals

If you want to continue deleting local duplicates, the safest next batch is:

1. Pi duplicate skills that are now canonical in the shared repo
2. Claude duplicate agents that are now canonical in the shared repo
3. Leave runtime-only items in place
4. Keep `AGENTS.md` pointers until the direct manifest load path is verified in practice

## Bottom line

- **Delete candidate**: most local Pi skill files and remaining Claude agent files
- **Keep**: Pi `firecrawl`, Pi extensions, Codex runtime skill assets
- **Keep pointer**: all `AGENTS.md` files
