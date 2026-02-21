import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { AgentRunner } from "./agent.js";
import { SessionDatabase } from "./database.js";
import { setupWebSocket } from "./websocket.js";
import { checkAndResumeAwaitingSessions } from "./resume.js";
import { setDebugLogging, debug } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const startupId = randomUUID();
setDebugLogging(config.debugLogging);

// Log resolved config (redact secrets)
debug("config", "resolved configuration", {
  model: config.model,
  haMcpUrl: config.haMcpUrl,
  dataDir: config.dataDir,
  port: config.port,
  debugLogging: config.debugLogging,
  apiKeyPresent: !!config.anthropicApiKey,
  apiKeySuffix: config.anthropicApiKey ? `...${config.anthropicApiKey.slice(-4)}` : "none",
  supervisorTokenPresent: !!config.supervisorToken,
  supervisorTokenSuffix: config.supervisorToken ? `...${config.supervisorToken.slice(-4)}` : "none",
});

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

// Initialize database
const db = new SessionDatabase(config.dataDir);
debug("startup", "database initialized", { path: path.join(config.dataDir, "habot.db") });

const agent = new AgentRunner(config);

const app = express();
const server = createServer(app);
app.use(express.json());

// HTTP request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    debug("http", `${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// WebSocket setup
setupWebSocket(server, config, db, startupId);

// Expose debug config to frontend
app.get("/api/config", (_req, res) => {
  res.json({ debugLogging: config.debugLogging, startupId });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Test endpoint for the agent (kept for curl testing)
app.post("/api/chat", async (req, res) => {
  const { message, sessionId } = req.body as {
    message?: string;
    sessionId?: string;
  };

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!config.anthropicApiKey) {
    res.status(500).json({ error: "Anthropic API key not configured" });
    return;
  }

  debug("http", `POST /api/chat`, { messageLength: message.length, sessionId });

  try {
    const result = await new Promise<{
      text: string;
      toolCalls: unknown[];
      sessionId: string;
      costUsd: number | null;
    }>((resolve, reject) => {
      agent.runQuery(message, sessionId ?? null, {
        onStreamText: () => {},
        onToolUse: () => {},
        onComplete: (r) => resolve(r),
        onError: (err) => reject(new Error(err)),
        onApprovalNeeded: async () => ({ approved: true }),
      });
    });

    debug("http", `POST /api/chat complete`, {
      responseLength: result.text.length,
      toolCallCount: result.toolCalls.length,
      costUsd: result.costUsd,
    });

    res.json({
      response: result.text,
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      costUsd: result.costUsd,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug("http", `POST /api/chat error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Entity search — proxies HA states API for @ mention autocomplete
app.get("/api/entities", async (req, res) => {
  const search = ((req.query.search as string) || "").toLowerCase();
  debug("http", `GET /api/entities search="${search}"`);

  if (!config.supervisorToken) {
    debug("http", "entity search failed: no supervisor token");
    res.status(503).json({ error: "Supervisor token not available" });
    return;
  }

  try {
    debug("http", "fetching HA states from supervisor API");
    const response = await fetch("http://supervisor/core/api/states", {
      headers: { Authorization: `Bearer ${config.supervisorToken}` },
    });

    if (!response.ok) {
      debug("http", `HA states API returned ${response.status}`);
      res.status(response.status).json({ error: "Failed to fetch entities from HA" });
      return;
    }

    const states = (await response.json()) as Array<{
      entity_id: string;
      state: string;
      attributes: Record<string, unknown>;
    }>;

    debug("http", `HA states fetched totalEntities=${states.length}`);

    const filtered = search
      ? states.filter(
          (s) =>
            s.entity_id.includes(search) ||
            String(s.attributes?.friendly_name ?? "").toLowerCase().includes(search),
        )
      : states;

    const results = filtered.slice(0, 50).map((s) => ({
      entityId: s.entity_id,
      friendlyName: (s.attributes?.friendly_name as string) ?? null,
      state: s.state,
      domain: s.entity_id.split(".")[0],
    }));

    debug("http", `entity search results=${results.length} (filtered from ${filtered.length})`);

    res.json(results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug("http", `entity search error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Serve frontend static files
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// SPA fallback — serve index.html for non-API routes
app.use((_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

server.listen(config.port, "0.0.0.0", () => {
  debug("startup", `server listening on port ${config.port}`);

  // Check for sessions that need to be resumed after HA restart
  if (config.anthropicApiKey) {
    debug("startup", "checking for sessions awaiting resume");
    checkAndResumeAwaitingSessions(config, db).catch((err) => {
      debug("startup", `error resuming sessions: ${err instanceof Error ? err.message : String(err)}`);
    });
  } else {
    debug("startup", "no API key configured, skipping resume check");
  }
});
