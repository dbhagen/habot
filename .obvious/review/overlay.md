# Review Overlay — dbhagen/habot

## Tooling-Handled (skip these)

- Type errors: `npx tsc --noEmit` runs in CI (`lint` job) for both packages — do not re-flag.
- Build/bundle failures: covered by the CI `build` job (Node 22).
- Commit message format: enforced by the CI `commitlint` job (Conventional Commits, warnings fail).
- YAML syntax in `repository.yaml` / `habot/config.yaml` / `habot/build.yaml`: covered by the CI `validate-addon` job. Semantic schema mistakes are NOT covered — see high-scrutiny below.
- Formatting: prettier via local pre-commit hooks (not in CI).

## High-Scrutiny Paths

- `habot/server/src/agent.ts` — approval enforcement. Scrutinize any change to `READ_ONLY_TOOLS`, `DESTRUCTIVE_TOOLS`, `RESTART_TOOLS`, or the `canUseTool` final branch: unlisted tools are allowed by default there, so moving tools between lists or widening the default-allow branch is a security-relevant behavior change.
- `habot/server/src/resume.ts` — post-restart auto-resume runs tool calls with **auto-approval** (no user present). Changes to when resume fires, the 10-minute TTL, or auto-approval behavior are security-critical.
- `habot/server/src/websocket.ts` — untrusted WS input, approval request/response handling, the session-scoped always-allow set, message queue draining.
- `habot/server/src/mask-secrets.ts` — every new egress path (DB write, WS send, log line) must stay routed through masking; check completeness, not just syntax.
- `habot/run.sh` — credential routing: `sk-ant-oat01-*` → `CLAUDE_CODE_OAUTH_TOKEN`, anything else → `ANTHROPIC_API_KEY`. Changes to parsing, defaults, or logged material must not expose secret values (12-char prefix logging is the intended limit).
- `habot/config.yaml` — users configure the add-on through this schema; type or option changes can break running installs.
- `habot/frontend/src/hooks/useWebSocket.ts` / `components/ApprovalPrompt.tsx` — the approval UI is presentation only; the server `canUseTool` hook is the enforcement point. Client-side changes must not be able to bypass server enforcement.
- Lockfile-only diffs (`package-lock.json`) — verify the lockfile change matches a stated dependency intent and no source file changed silently alongside it.

## Architecture

- See `AGENTS.md` for the repo map, commands, and conventions.
- See `.obvious/orientation/codebase-map.md` for the packaging flow, runtime data flow, approval-machinery file index, and restart/resume flow.
- There is no test suite (see `.obvious/qa.md`): "tests pass" is never available as evidence — behavioral claims must be argued from code.
