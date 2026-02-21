#!/bin/sh
# ==============================================================================
# Home Assistant Add-on: HABot
# Reads config from /data/options.json (written by Supervisor before start)
# ==============================================================================
set -e

# Read config from the options file the Supervisor writes before container start
CONFIG=$(cat /data/options.json 2>/dev/null || echo '{}')

# Read the configured key and export as the correct env var based on key type.
# OAuth tokens (sk-ant-oat01-...) must be CLAUDE_CODE_OAUTH_TOKEN; API keys use ANTHROPIC_API_KEY.
_KEY=$(echo "$CONFIG" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('anthropic_api_key',''))" 2>/dev/null || echo "")
case "$_KEY" in
  sk-ant-oat01-*)
    export CLAUDE_CODE_OAUTH_TOKEN="$_KEY"
    ;;
  *)
    export ANTHROPIC_API_KEY="$_KEY"
    ;;
esac

export HA_MCP_URL=$(echo "$CONFIG" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('ha_mcp_url','http://localhost:9583/mcp'))" 2>/dev/null || echo "http://localhost:9583/mcp")

export CLAUDE_MODEL=$(echo "$CONFIG" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('model','claude-sonnet-4-6'))" 2>/dev/null || echo "claude-sonnet-4-6")

export DEBUG_LOGGING=$(echo "$CONFIG" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print('true' if d.get('debug_logging', False) else 'false')" 2>/dev/null || echo "false")

export DATA_DIR="/data"

_KEY_DISPLAY="${ANTHROPIC_API_KEY:-${CLAUDE_CODE_OAUTH_TOKEN}}"
_KEY_TYPE="$( [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "oauth" || echo "apikey" )"
echo "[HABot] Config: model=${CLAUDE_MODEL} debug=${DEBUG_LOGGING} keyType=${_KEY_TYPE} key=${_KEY_DISPLAY:0:12}..."
echo "[HABot] Starting on port 8099..."
exec node /app/dist/index.js
