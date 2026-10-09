import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { SessionDatabase } from "../src/database.js";
import { setupWebSocket } from "../src/websocket.js";
import type { Config } from "../src/config.js";
import type { ServerMessage } from "../src/types.js";

/**
 * Starts the REAL websocket layer (setupWebSocket) on an ephemeral loopback
 * port with a disposable SQLite data dir. No Home Assistant, no Anthropic —
 * the agent boundary is controlled per-test (see approval-flow.test.ts).
 */
export interface TestServer {
  port: number;
  dataDir: string;
  db: SessionDatabase;
  config: Config;
  close: () => Promise<void>;
}

export const TEST_STARTUP_ID = "test-startup-id";

export async function startTestServer(
  overrides: Partial<Config> = {},
): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "habot-test-"));
  const db = new SessionDatabase(dataDir);
  const config: Config = {
    anthropicApiKey: "",
    haMcpUrl: "http://127.0.0.1:1/mcp", // unroutable loopback port, never dialed
    model: "test-model",
    supervisorToken: "",
    dataDir,
    port: 0,
    debugLogging: false,
    ...overrides,
  };

  const httpServer: Server = createServer();
  // Node detaches sockets from the server's connection tracking when they are
  // upgraded to WebSocket, so closeAllConnections() cannot reach them. Track
  // every upgraded socket ourselves (registered BEFORE setupWebSocket) and
  // destroy them on close().
  const upgradedSockets = new Set<import("node:net").Socket>();
  httpServer.on("upgrade", (_req, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
  });
  setupWebSocket(httpServer, config, db, TEST_STARTUP_ID);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP address with ephemeral port");
  }

  return {
    port: address.port,
    dataDir,
    db,
    config,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Upgraded WebSocket sockets are detached from the HTTP server's
        // connection tracking (closeAllConnections cannot reach them), so
        // destroy every socket we observed on the upgrade event.
        httpServer.close((err) => {
          try {
            rmSync(dataDir, { recursive: true, force: true });
          } catch {
            // best-effort temp cleanup
          }
          if (err) reject(err);
          else resolve();
        });
        for (const socket of upgradedSockets) socket.destroy();
        httpServer.closeAllConnections();
      }),
  };
}

export class TestClient {
  readonly ws: WebSocket;
  private received: ServerMessage[] = [];
  private waiters: Array<{
    predicate: (msg: ServerMessage) => boolean;
    resolve: (msg: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(ws: WebSocket) {
    // Wire the close promise in the constructor body — with
    // useDefineForClassFields, field initializers run in declaration order
    // and a later declared-but-uninitialized field would clobber
    // this.resolveClosed assigned during the `closed` initializer.
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.ws = ws;
    ws.once("close", () => this.resolveClosed());
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.received.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.predicate(msg)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** All messages received so far (snapshot). */
  all(): ServerMessage[] {
    return [...this.received];
  }

  count(type: ServerMessage["type"]): number {
    return this.received.filter((m) => m.type === type).length;
  }

  waitFor(
    predicate: (msg: ServerMessage) => boolean,
    timeoutMs = 2_000,
  ): Promise<ServerMessage> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for message; received: ${JSON.stringify(this.received.map((m) => m.type))}`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  waitForType(type: ServerMessage["type"], timeoutMs = 2_000): Promise<ServerMessage> {
    return this.waitFor((m) => m.type === type, timeoutMs);
  }

  /** Resolves after `ms` of silence — used to pin "no response" behaviors. */
  static async expectSilence(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  terminate(): void {
    this.ws.terminate();
  }
}

export async function connectClient(port: number, wsPath = "/ws"): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  // Attach the message listener BEFORE awaiting open: the server sends
  // server_hello at connection time, and a frame arriving before the
  // listener exists would be silently lost.
  const client = new TestClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return client;
}
