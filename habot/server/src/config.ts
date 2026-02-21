export interface Config {
  anthropicApiKey: string;
  haMcpUrl: string;
  model: string;
  supervisorToken: string;
  dataDir: string;
  port: number;
  debugLogging: boolean;
}

export function loadConfig(): Config {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    haMcpUrl: process.env.HA_MCP_URL ?? "http://localhost:9583/mcp",
    model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
    supervisorToken: process.env.SUPERVISOR_TOKEN ?? "",
    dataDir: process.env.DATA_DIR ?? "/data",
    port: parseInt(process.env.PORT ?? "8099", 10),
    debugLogging: process.env.DEBUG_LOGGING === "true",
  };
}
