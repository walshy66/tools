# Pi runtime extensions

This folder stores Pi-specific runtime extensions for the shared workflow repo.

## Important

Pi does **not** auto-discover this folder by itself unless you point Pi at it.

Use one of these options:

1. **Project-local discovery**
   - copy or symlink an extension into `.pi/extensions/` in the project you are working in

2. **Global Pi settings**
   - add this folder to Pi's `extensions` list in `~/.pi/agent/settings.json`

## For a fresh checkout

For each extension folder that has a `package.json`:

```bash
cd shared-workflows/pi/extensions/<name>
npm ci
```

## How to make Pi load these extensions

Pick one:

### Option A: global Pi config
Add this folder to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "C:/Users/<you>/Documents/projects/tools/shared-workflows/pi/extensions"
  ]
}
```

### Option B: project-local copy or symlink
Copy or symlink the extension folder into the project’s `.pi/extensions/` directory.

## Example

- `fly/` — Fly.io / flyctl wrapper commands and tools
- `crosby/` — Linear execution orchestrator
