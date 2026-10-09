# Local Development — Verified Commands

Every command below was executed against the repo at HEAD `d7071c6` (branch `docs/orientation-obvious`) on 2026-10-09 and the actual output recorded. Environment notes: build sandbox has **Node v20.20.2**; CI and the Dockerfile use **Node 22**. No API keys or Home Assistant instance involved in any of these steps.

## Install & Build (server)

```text
$ cd habot/server && node --version
v20.20.2

$ npm ci --no-audit --no-fund
(npm notice about npm 12.2.0 update — informational; install succeeded)

$ npm run build
> habot-server@0.1.2 build
> tsc
(exit 0, no errors)

$ npx tsc --noEmit
SERVER_TSC_OK
```

`npm ci` compiles the `better-sqlite3` native module (the Dockerfile adds `python3 make g++` for this on alpine; prebuilt binaries covered it here).

## Install & Build (frontend)

```text
$ cd habot/frontend
$ npm ci --no-audit --no-fund
added 166 packages in 2s

$ npm run build
> habot-frontend@0.1.2 build
> tsc -b && vite build
✓ 291 modules transformed.
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-BR7XsXIj.css   15.54 kB │ gzip:   3.46 kB
dist/assets/index-BUX1RTjc.js   385.02 kB │ gzip: 118.52 kB
✓ built in 1.57s

$ npx tsc --noEmit
FRONTEND_TSC_OK
```

## Dev Servers (smoke-tested)

```text
$ cd habot/server && DATA_DIR=/tmp/habot-dev-smoke PORT=8099 npm run dev
> tsx watch src/index.ts

$ curl http://localhost:8099/api/health
{"status":"ok"}
$ curl http://localhost:8099/api/config
{"debugLogging":false,"startupId":"12777599-0786-46ca-9ef6-78483ebff2aa"}
```

The server boots with **no API key configured**; chat requests error with a "key not configured" message until `anthropic_api_key` is set (in the add-on's Configuration tab at runtime — never in git).

```text
$ cd habot/frontend && npx vite --port 5173
$ curl -o /dev/null -w "%{http_code}" http://localhost:5173/
200
```

Note: `vite.config.ts` has no dev proxy, so in dev the frontend's `/api/*` and `/ws` calls hit the vite origin and fail. Exercise the full UI against the built app served by the backend (or behind HA Ingress).

## Add-on Manifest Validation (mirrors the CI `validate-addon` job)

```bash
python3 -c "
import yaml, sys
for f in ['repository.yaml', 'habot/config.yaml', 'habot/build.yaml']:
    yaml.safe_load(open(f))
    print(f'OK: {f}')
"
```

Run locally on this branch: all three parse OK.

## Lint/Commit Hooks

- `.pre-commit-config.yaml` hooks (whitespace, YAML/JSON checks, private-key detection, prettier, conventional commit messages) are **local-only** — they run if you `pre-commit install`; CI does not run them.
- Conventional commits are enforced remotely: the CI `commitlint` job (`wagoid/commitlint-github-action@v6`, `failOnWarnings: true`) runs on PRs only.

## What These Commands Prove and Don't

They prove the packages install, typecheck, build, and the server serves its HTTP endpoints. They do not exercise the Claude Agent SDK loop, ha-mcp, or Home Assistant — see `.obvious/qa.md` for the full gate/limitation list.
