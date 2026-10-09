import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
// happy-dom does not ship a WebSocket implementation. Inject the `ws` client
// so the real hook code drives a real local server over 127.0.0.1.
import { WebSocket as NodeWebSocket } from "ws";

(globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket;

afterEach(() => {
  cleanup();
});
