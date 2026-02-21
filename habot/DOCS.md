# HABot for Home Assistant

Chat with HABot to inspect, troubleshoot, and reconfigure your Home Assistant setup.

## Prerequisites

1. **ha-mcp add-on** — Install from <https://github.com/homeassistant-ai/ha-mcp>. This provides Claude with tools to interact with Home Assistant.
2. **Anthropic API key** — Create one at <https://console.anthropic.com/settings/keys>.

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
