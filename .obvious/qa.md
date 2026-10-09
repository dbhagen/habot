# QA — Gates, Guarantees, and Limits

Last verified 2026-10-09 at HEAD `d7071c6`. Automation paths are declared in `.obvious/config.yml` (`qa.automationPaths` → `.github/workflows/ci.yaml`).

## CI Gates (`.github/workflows/ci.yaml`)

Runs on push and PRs to `main`. Four jobs:

| Gate | What it runs | What it proves |
|---|---|---|
| **commitlint** (PRs only) | `wagoid/commitlint-github-action@v6`, `failOnWarnings: true`, full history | Every commit in the PR follows Conventional Commits (`@commitlint/config-conventional`) |
| **build** | Node 22; `npm ci` + `npm run build` for server and frontend | Both packages install from lockfiles and compile to artifacts |
| **lint** | Node 22; `npx tsc --noEmit` for server and frontend | Type-level correctness (the frontend's vite bundle step does not typecheck; its `tsc -b` build step does) |
| **validate-addon** | `python3` + `yaml.safe_load` over `repository.yaml`, `habot/config.yaml`, `habot/build.yaml` | The three YAML manifests are syntactically valid |

`.github/workflows/release.yaml` (push to `main`, skipped on `chore(release):` commits) derives a semver bump from conventional commit types, rewrites the version in `habot/config.yaml` and both `package.json` files, regenerates `habot/CHANGELOG.md`, tags, and publishes a GitHub Release.

## What These Gates Prove About the Product

Very little beyond "it compiles and the manifests parse." The gates contain **no tests** — there is no test suite in either package. Nothing in CI executes the agent loop, exercises the WebSocket protocol, or runs the approval flow.

## What Cannot Be Proven on This Hardware

Recorded so no one mistakes a green check for runtime verification:

- **No Home Assistant / Supervisor runtime.** The add-on has never been installed through an HA add-on store in this environment; Ingress serving, `/data/options.json` delivery, `SUPERVISOR_TOKEN` injection, and the `/api/entities` Supervisor proxy are code-read-only claims.
- **No ha-mcp instance.** Every `mcp__ha-mcp__*` tool interaction (including `ha_backup_create` before destructive changes) is mediated by the external ha-mcp server at `HA_MCP_URL`; nothing here can confirm it responds.
- **No Anthropic API calls.** The Claude Agent SDK loop, streaming, token/cost accounting, and session resume require live credentials; agent-facing behavior is verified by reading `agent.ts`/`resume.ts`, not by execution.
- **No browser/E2E harness.** The ApprovalPrompt UI (Approve / Always-allow / Deny / instructions), streaming rendering, and Ingress URL derivation have no automated coverage.
- **Restart resilience** (`awaiting_resume` → startup auto-resume, 10-min TTL, auto-approval during resume) depends on HA restarting the container — untestable without an HA instance.

Any acceptance evidence for runtime behavior must come from a disposable Home Assistant instance with a test ha-mcp endpoint and Anthropic credentials handled per the repo security rules (add-on storage only, never git).
