# Shared Workflows

Canonical shared content for tools and agents.

## Manifest

- `manifest.json` — canonical inventory of shared skills, agents, and templates

## Canonical Portable Skills

- `tdd`
- `to-prd`
- `to-issues`
- `grill-me`
- `git-guardrails-claude-code`
- `analyze`
- `clarify`
- `code-reviewer`
- `design-reviewer`
- `design`
- `handover`
- `handover-idea`
- `implement`
- `ralph-loop`
- `plan`
- `specify`
- `tasks`

## Layout

- `portable/` — reusable, model-agnostic skills, agents, and templates
- `pi/` — Pi-specific runtime extensions and adapters
- `references/` — shared reference documents such as the constitution

## Pi Extensions

- Canonical Pi extension source for Crosby lives at `shared-workflows/pi/extensions/crosby/`
- To make `/crosby` available in all projects, install a global re-export at:
  - `C:/Users/camer/.pi/agent/extensions/crosby/index.ts`
- Global re-export contents:

```ts
export { default } from "C:/Users/camer/Documents/projects/tools/shared-workflows/pi/extensions/crosby/index.ts";
```

- After adding or updating the global re-export, run `/reload` in pi
- `/crosby` is an extension command, not a skill
