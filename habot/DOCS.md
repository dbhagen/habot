# HABot for Home Assistant

Chat with HABot to inspect, troubleshoot, and reconfigure your Home Assistant setup.

## Prerequisites

1. **ha-mcp add-on** — Install from <https://github.com/homeassistant-ai/ha-mcp>. This provides Claude with tools to interact with Home Assistant.
2. **Anthropic API key** — Create one at <https://console.anthropic.com/settings/keys>.

## Configuration

| Option | Description |
|--------|-------------|
| `anthropic_api_key` | Your Anthropic API key, or a Claude subscription token (`sk-ant-oat01-…`). The add-on detects the type from the token prefix and passes it to Claude with the correct credential field. |
| `ha_mcp_url` | URL of the ha-mcp server (default: `http://localhost:9583/mcp`) |
| `model` | Claude model to use: `claude-sonnet-4-6` (recommended), `claude-haiku-4-5`, or `claude-opus-4-6` |
| `debug_logging` | Enable verbose debug logging (default: `false`) |

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

Claude asks for your approval before destructive operations (restarting or reloading Home Assistant, editing or deleting automations and dashboards, service calls, file writes) — pending approvals are denied if unanswered for five minutes. Before destructive changes, Claude is instructed to create a Home Assistant backup first (via ha-mcp's backup tool).
