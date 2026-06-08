# Fly extension

Pi runtime extension for Fly.io / `flyctl`.

## What it adds

Slash commands:
- `/fly`
- `/fly-version`
- `/fly-auth-whoami`
- `/fly-apps-list`
- `/fly-app-info`
- `/fly-status`
- `/fly-logs`
- `/fly-deploy`
- `/fly-secrets-set`
- `/fly-secrets-list`
- `/fly-machines-list`
- `/fly-machines-restart`
- `/fly-machines-stop`
- `/fly-machines-destroy`

Tools with the same names also exist without the slash.

## Prereqs

- Install `flyctl`
- Sign in with `flyctl auth login`
- Or set `FLY_API_TOKEN` for automation

## Setup for a fresh checkout

```bash
cd shared-workflows/pi/extensions/fly
npm ci
```

## First-use fallback

If a user tries a Fly command and it fails, the agent should:

1. check whether `flyctl` is installed
2. install `flyctl` if missing
3. run `flyctl auth login` if the user is not authenticated
4. run `npm ci` in this folder if dependencies are missing
5. reload Pi / restart the session so the extension is discovered
6. retry the requested Fly command

## Example

```text
/fly status -a simplets
```
