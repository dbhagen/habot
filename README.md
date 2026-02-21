# HABot for Home Assistant

[![CI](https://github.com/dbhagen/habot/actions/workflows/ci.yaml/badge.svg)](https://github.com/dbhagen/habot/actions/workflows/ci.yaml)
[![GitHub Release](https://img.shields.io/github/v/release/dbhagen/habot)](https://github.com/dbhagen/habot/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Home Assistant Supervisor add-on that brings Claude-powered AI interaction directly into Home Assistant. Chat with Claude to inspect, troubleshoot, and reconfigure your setup — automations, entities, dashboards, and more — through a conversational web UI served via HA's Ingress system.

## What It Does

Claude has broad read/write access to Home Assistant through [ha-mcp](https://github.com/homeassistant-ai/ha-mcp), which exposes 97 tools covering entity control, automation CRUD, dashboard management, system administration, and more. You describe what you want in natural language, and Claude makes it happen.

**Key capabilities:**
- Create and edit automations, scripts, and scenes
- Control entities and devices across your home
- Build and modify Lovelace dashboards
- Debug automations with trace inspection
- Manage system updates, backups, and restarts
- Search and discover entities, areas, and configurations

## Prerequisites

| Requirement | Details |
|---|---|
| **Home Assistant OS or Supervised** | 2024.1+ required for Supervisor add-on support |
| **[ha-mcp](https://github.com/homeassistant-ai/ha-mcp)** add-on | Provides the 97 MCP tools Claude uses to interact with HA |
| **Anthropic API key** | Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys) |

## Installation

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**
2. Click the **three dots** menu (top right) > **Repositories**
3. Add this repository URL:
   ```
   https://github.com/dbhagen/habot
   ```
4. Find **HABot** in the add-on store and click **Install**
5. Enter your Anthropic API key in the **Configuration** tab
6. Start the add-on and click **Open Web UI**

## Configuration

| Option | Default | Description |
|---|---|---|
| `anthropic_api_key` | — | Your Anthropic API key ([get one here](https://console.anthropic.com/settings/keys)) |
| `ha_mcp_url` | `http://localhost:9583/mcp` | URL of the ha-mcp server |
| `model` | `claude-sonnet-4-6` | Model to use: `claude-sonnet-4-6`, `claude-haiku-4-5`, or `claude-opus-4-6` |
| `debug_logging` | `false` | Enable verbose debug logging |

## Usage Examples

> **"My living room lights turn on at sunset but I want them to only turn on if someone is home."**
>
> Claude finds the automation, adds a presence condition, shows you the diff, and applies the change after your approval.

> **"Why does my garage door automation keep triggering at 3am?"**
>
> Claude reads the automation config, inspects traces, checks entity history, identifies the cause, and suggests a fix.

> **"Create a dashboard card that shows the temperature from all my sensors."**
>
> Claude discovers your temperature sensors, picks the right card type, generates the config, and adds it to your dashboard.

> **"Back up my config and then update Home Assistant."**
>
> Claude creates a backup, checks for available updates, and walks you through the process.

## Safety

- Claude asks for **approval before destructive changes** (editing automations, restarting HA, etc.)
- **Automatic backups** are created before significant configuration modifications
- **Restart resilience** — if Claude triggers an HA restart, the conversation auto-resumes when HA comes back up
- All data stays local to your HA instance; nothing leaves your network except API calls to Anthropic

## Architecture

```
Browser (HA Ingress)
    ↕ WebSocket
HABot Server (Express + ws, port 8099)
    ↕ Claude Agent SDK
    ↕ Anthropic API        ↕ ha-mcp (97 tools)
                                ↕ Home Assistant API
```

The add-on runs a Node.js server with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) for the agent loop and connects to ha-mcp via MCP for full HA access. The React frontend communicates over WebSocket through HA's Ingress proxy.

## Development

```bash
# Server (hot-reload)
cd habot/server && npm install && npm run dev

# Frontend (HMR)
cd habot/frontend && npm install && npm run dev

# Production build
cd habot/server && npm run build
cd habot/frontend && npm run build
```

See [CLAUDE.md](CLAUDE.md) for detailed development documentation.

## Contributing

Contributions are welcome! Please open an issue or pull request.

This project uses [pre-commit](https://pre-commit.com/) hooks — install them with:
```bash
pip install pre-commit
pre-commit install
```

## Support This Project

If you find HABot useful, consider buying me a coffee!

[![Venmo](https://img.shields.io/badge/Venmo-@dbhagenatx-blue?logo=venmo&logoColor=white)](https://venmo.com/dbhagenatx)

## License

[MIT](LICENSE)
