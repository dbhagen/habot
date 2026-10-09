import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

export interface RecordedMessage {
  connection: number;
  message: Record<string, unknown>;
}

export interface RecordingWsServer {
  port: number;
  connectionCount: number;
  connections: ServerSocket[];
  received: RecordedMessage[];
  currentStartupId: string;
  sendTo: (connection: number, payload: unknown) => void;
  dropAll: () => void;
  close: () => Promise<void>;
}

/**
 * A disposable loopback WebSocket server that records what connected clients
 * send and greets every connection with a server_hello. Used to exercise the
 * real useWebSocket hook against real socket semantics.
 */
export async function startRecordingWsServer(initialStartupId: string): Promise<RecordingWsServer> {
  const httpServer: Server = createServer();
  // Upgraded sockets are detached from the HTTP server's connection tracking,
  // so track them for deterministic teardown.
  const upgradedSockets = new Set<Duplex>();
  httpServer.on("upgrade", (_req, socket) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
  });

  const wss = new WebSocketServer({ server: httpServer });
  const server: RecordingWsServer = {
    port: 0,
    connectionCount: 0,
    connections: [],
    received: [],
    currentStartupId: initialStartupId,
    sendTo: (connection, payload) => {
      const ws = server.connections[connection];
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    },
    dropAll: () => {
      for (const ws of server.connections) ws.terminate();
    },
    close: async () => {},
  };

  wss.on("connection", (ws: ServerSocket) => {
    const idx = server.connectionCount++;
    server.connections.push(ws);
    ws.send(JSON.stringify({ type: "server_hello", startupId: server.currentStartupId }));
    ws.on("message", (data) => {
      server.received.push({ connection: idx, message: JSON.parse(String(data)) });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP address with ephemeral port");
  }
  server.port = address.port;

  server.close = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      for (const socket of upgradedSockets) socket.destroy();
      httpServer.closeAllConnections();
    });

  return server;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
