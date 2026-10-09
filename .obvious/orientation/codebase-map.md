# HABot Codebase Map

Default branch: **`main`**. All paths verified to exist at HEAD `d7071c6`.

## Add-on Packaging Flow

1. **`repository.yaml`** — makes the GitHub repo installable as an add-on repository in Home Assistant (name, URL, maintainer).
2. **`habot/config.yaml`** — the add-on manifest. Declares options + schema (`anthropic_api_key` `str`, `ha_mcp_url` `url`, `model` `list(claude-sonnet-4-6|claude-haiku-4-5|claude-opus-4-6)`, `debug_logging` `bool`), `ingress: true` on port 8099, `hassio_api: true` + `homeassistant_api: true` (Supervisor API access for entity search and agent shell use), `host_network: true` (so `localhost:9583` reaches the ha-mcp add-on), and the version string that `release.yaml` bumps.
3. **`habot/build.yaml`** — per-arch base images (`ghcr.io/home-assistant/{amd64,aarch64}-base:3.20`).
4. **`habot/Dockerfile`** — builder stage on `node:22-alpine` (plus `python3 make g++` for the `better-sqlite3` native module): `npm ci` + `npm run build` for server and frontend. Runtime stage: copies `server/dist` → `/app/dist`, `server/node_modules`, frontend `dist` → `/app/public`, `run.sh` → `/run.sh`. `CMD ["/run.sh"]`.
5. **`habot/run.sh`** — entrypoint. Supervisor writes `/data/options.json` before start; the script parses it with `python3` and exports:
   - `anthropic_api_key` → `CLAUDE_CODE_OAUTH_TOKEN` if it starts with `sk-ant-oat01-`, else `ANTHROPIC_API_KEY` (same schema field, two credential kinds; `config.ts` accepts either env var)
   - `ha_mcp_url` → `HA_MCP_URL` (default `http://localhost:9583/mcp`)
   - `model` → `CLAUDE_MODEL` (default `claude-sonnet-4-6`)
   - `debug_logging` → `DEBUG_LOGGING` (`true`/`false`)
   - `DATA_DIR=/data`
   It logs model/debug/key-type/12-char key prefix, then `exec node /app/dist/index.js`.

## Runtime Data Flow

```
Browser ── HA Ingress (ingress_stream: true) ──► Express (static /app/public) + ws on :8099
   │                                                    │
   │  WS messages: send_message / approve_tool /        │ Claude Agent SDK query loop
   │  cancel / session CRUD                             ▼
   │                                              Anthropic API
   │                                                    │
   │  /api/entities ◄── Supervisor API (SUPERVISOR_TOKEN, http://supervisor/core/api/states)
   ▼                                                    ▼
 approval UI (ApprovalPrompt.tsx)            ha-mcp MCP server (HTTP, HA_MCP_URL) ──► Home Assistant
```

- `habot/server/src/websocket.ts` owns the WS protocol (`types.ts` defines the message union). Messages sent while the agent is busy are queued per session and drained on completion.
- `habot/server/src/agent.ts` runs the SDK loop with `allowedTools: ["mcp__ha-mcp__*"]`, built-in tools `Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch`, `cwd: /config`, `maxTurns: 50`.
- `habot/frontend/src/utils/ingress.ts` derives WS/API URLs from the Ingress path so no port or token is hardcoded client-side.

## Approval Machinery (where each guarantee lives)

| Mechanism | Where |
|---|---|
| Read-only tool allowlist (auto-approved, incl. `ha_backup_create`) | `agent.ts` `READ_ONLY_TOOLS` |
| Destructive-tool list requiring approval (restart/reload, automation & dashboard set/delete, `ha_call_service`, `ha_backup_restore`, `Bash/Write/Edit`) | `agent.ts` `DESTRUCTIVE_TOOLS` |
| **Default-allow for any tool not on either list** | `agent.ts` `canUseTool` final branch |
| Session-scoped "always allow" honored before prompting | `websocket.ts` `autoApprovedTools` + `approve_tool` handler |
| Approval prompt with Approve / Always-allow / Deny / Deny-with-instructions | `frontend/src/components/ApprovalPrompt.tsx` |
| 5-minute approval timeout → auto-deny; cancel → auto-deny pending | `websocket.ts` `onApprovalNeeded` / `cancel` handler |
| Secret masking of approval inputs and all WS/DB egress | `mask-secrets.ts`, applied in `websocket.ts` and `resume.ts` |
| Auto-approve during post-restart resume (no user present) | `resume.ts` `onApprovalNeeded` |
| Auto-approve on the `/api/chat` curl-test endpoint | `server/src/index.ts` |

## Restart / Resume Flow

1. Approved restart tool (`ha_restart`, `ha_reload_core`, `ha_backup_restore` — `agent.ts` `RESTART_TOOLS`) → `websocket.ts` `onRestartDetected` → `database.ts` `setResumeContext` marks the session `awaiting_resume` with a context string.
2. HA restarts; the add-on (and container) comes back with `boot: auto`.
3. `index.ts` startup → `resume.ts` `checkAndResumeAwaitingSessions`: sessions awaiting ≤ 10 min are resumed via the SDK `resume` session ID with a "Home Assistant has restarted… verify" prompt; older ones get a timeout system message and go idle.
4. If the SDK session is stale, `agent.ts` `runQuery` retries once without resume, injecting DB conversation history into the system prompt instead.

## Persistence

- `better-sqlite3` (WAL) at `$DATA_DIR/habot.db` — i.e. `/data/habot.db` in the container — tables `sessions` + `messages` with `ON DELETE CASCADE` and two add-column migrations (`images`, `segments`). All egress (DB writes, WS sends) passes through `mask-secrets.ts`.

## Generated / Do-Not-Hand-Edit

- `habot/CHANGELOG.md` and version strings in `habot/config.yaml` + both `package.json` files are rewritten by `.github/workflows/release.yaml` on push to `main`.
