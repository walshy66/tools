# tools

**Version:** `1.0.6`

Shared workflow and agent assets for multiple tools.

## Current State

- The shared repo is the canonical source of truth for portable skills, agents, templates, and the constitution.
- Local duplicate skill/agent copies have been removed from Pi and Claude Code.
- Pi is configured to load shared skills directly from `shared-workflows/portable/skills`.
- Pi, Claude Code, and Codex point to the shared manifest through their local `AGENTS.md` files.
- `pi/extensions/` remains for Pi-specific runtime extensions and adapters.
- Codex currently keeps only runtime-specific assets outside the shared portable workflow set.
- The constitution is stored canonically at `shared-workflows/references/constitution.md`.
- Projects should use a root-level `constitution.md` symlink to that canonical file when possible.
- If a symlink is not possible on a platform, use a direct copy and keep it in sync with the canonical file.
- Claude Code project starters now live in `shared-workflows/portable/templates/claude-code-project-template.md`.

## Layout

```text
shared-workflows/
├── manifest.json
├── portable/
│   ├── skills/
│   ├── agents/
│   └── templates/
└── pi/
    └── extensions/
```

## Purpose

- Keep reusable workflow instructions in one canonical repository.
- Make shared skills, agents, templates, and constitution access available across Pi, Claude Code, and Codex without duplication.
- Preserve portability by keeping shared content model-agnostic.
- Keep Pi-specific runtime behavior isolated in `pi/extensions/`.
- Use direct manifest reading so tools resolve the shared source of truth instead of maintaining separate local copies.
- Prefer symlinks for project-facing constitution access; use copies only as a fallback when symlinks are not available.
- Keep Claude Code project scaffolding in shared templates and copy it into each project as needed.

## How Updates Propagate

1. Edit the canonical skill/agent/template in `shared-workflows/`.
2. Commit the change to this repo and push it to GitHub.
3. Reload or restart the tool.
4. The tool reads the shared repo location/manifest and picks up the latest version on the next load.

### Important notes

- Pi is configured to discover skills from `C:/Users/camer/Documents/projects/tools/shared-workflows/portable/skills`.
- Claude Code is configured through `C:/Users/camer/.claude/skills` which points at the shared skills directory.
- Codex is configured through `C:/Users/camer/.agents/skills` which points at the shared skills directory.
- The constitution lives at `shared-workflows/references/constitution.md`.
- Each project root should have a `constitution.md` link to that file; use a symlink when supported, otherwise use a direct copy.
- GitHub is the source of truth; local copies should stay minimal or be removed when no longer needed.

## Canonical Shared Content

The current portable set includes:

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

The current portable templates include:

- `prd-template`
- `issue-slice-template`
- `claude-code-project-template`

The current portable templates include:

- `prd-template`
- `issue-slice-template`
- `claude-code-project-template`

## Notes

- Update `shared-workflows/manifest.json` whenever portable content changes.
- Bump the version number in this README when the shared workflow structure or canonical set changes.
- Keep local tool folders minimal and runtime-specific.
