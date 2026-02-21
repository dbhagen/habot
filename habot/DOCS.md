# HABot for Home Assistant

Chat with HABot to inspect, troubleshoot, and reconfigure your Home Assistant setup.

## Prerequisites

1. **ha-mcp add-on** — Install from <https://github.com/homeassistant-ai/ha-mcp>. This provides Claude with tools to interact with Home Assistant.
2. **API key** — Either a paid Anthropic API key, or a token generated from a Claude subscription (see below).

## Getting an API Key

### Option A: Claude Subscription Token (Pro/Max/Team) — Recommended

If you already have a Claude subscription, you can generate a long-lived API token from it using the Claude Code CLI. This uses your subscription's quota rather than separate pay-per-token billing.

1. Install [Claude Code](https://claude.ai/code): `npm install -g @anthropic-ai/claude-code`
2. Log in with your Claude account: `claude login`
3. Generate a token: `claude setup-token`
4. Copy the token and paste it into the `anthropic_api_key` field in the add-on configuration.

### Option B: Anthropic API Key (Pay-per-token)

Create an API key at <https://console.anthropic.com/settings/keys>. Usage is billed per-token to your Anthropic account (separate from any Claude subscription).

## Configuration

| Option | Description |
|--------|-------------|
| `anthropic_api_key` | Your API key or subscription token (see above) |
| `ha_mcp_url` | URL of the ha-mcp server (default: `http://localhost:9583/mcp`) |
| `model` | Claude model to use: `claude-sonnet-4-6` (recommended), `claude-haiku-4-5`, or `claude-opus-4-6` |

## Usage

1. Install and configure both ha-mcp and this add-on
2. Enter your API key in the add-on configuration
3. Start the add-on and click **OPEN WEB UI**
4. Chat with Claude about your Home Assistant setup

## Examples

- "What entities are in my living room?"
- "Create an automation that turns on the porch light at sunset"
- "Why does my garage door automation keep triggering at 3am?"
- "Show me all my temperature sensors and their current readings"
- "Back up my config and then update Home Assistant"

## Safety

Claude will ask for your approval before making destructive changes (editing automations, restarting HA, etc.) and automatically creates backups before significant modifications.
