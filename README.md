# tools

Shared workflow and agent assets for multiple tools.

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

## Intent

- `manifest.json` is the canonical inventory for shared skills, agents, and templates.
- `portable/` contains model/tool-agnostic Markdown assets that Pi, Claude Code, and Codex can all consume.
- `pi/extensions/` contains Pi-specific runtime extensions or adapters.
- Keep reusable instructions in `portable/` and only put Pi-only behavior in `pi/extensions/`.
