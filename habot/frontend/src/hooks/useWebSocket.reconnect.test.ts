import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "./useWebSocket";
import { sleep, startRecordingWsServer, type RecordingWsServer } from "../test/ws-server";

// Synthetic session fixture matching the server's session_created shape.
const syntheticSession = {
  id: "session-1",
  name: "Test Session",
  status: "active",
  agentSessionId: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
} as const;

describe("useWebSocket reconnect semantics", () => {
  let server: RecordingWsServer;

  beforeEach(async () => {
    server = await startRecordingWsServer("startup-a");
    // Drive the real ingress URL derivation from the page location.
    (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
      `http://127.0.0.1:${server.port}/`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("connects on mount and reports connected once the socket opens", async () => {
    const { result } = renderHook(() => useWebSocket(null));
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(server.connectionCount).toBe(1);
  });

  it("reconnects after the fixed ~2s delay, not immediately (pinned: no backoff, unlimited retries)", async () => {
    const { result } = renderHook(() => useWebSocket(null));
    await waitFor(() => expect(result.current.connected).toBe(true));

    server.dropAll();
    await waitFor(() => expect(result.current.connected).toBe(false));

    // Current behavior: a single fixed 2s delay — no immediate retry burst,
    // no exponential backoff. The next attempt lands between ~2s and ~4s.
    await sleep(600);
    expect(server.connectionCount).toBe(1);

    await waitFor(() => expect(result.current.connected).toBe(true), { timeout: 5000 });
    expect(server.connectionCount).toBe(2);
  });

  it("after a same-startup-id reconnect: no page reload and no state re-request (pinned current behavior)", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const { result } = renderHook(() => useWebSocket(null));
    await waitFor(() => expect(result.current.connected).toBe(true));

    result.current.createSession();
    await waitFor(() =>
      expect(server.received.some((r) => r.message.type === "create_session")).toBe(true),
    );
    server.sendTo(0, { type: "session_created", session: syntheticSession });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    server.dropAll();
    await waitFor(() => expect(result.current.connected).toBe(false));
    await waitFor(() => expect(result.current.connected).toBe(true), { timeout: 5000 });
    expect(server.connectionCount).toBe(2);

    // Same startup id means the add-on did not restart — no reload.
    expect(reload).not.toHaveBeenCalled();

    // Current behavior (pinned): the hook does not re-fetch session state
    // after a reconnect. Previously loaded state stays as-is; the UI keeps
    // showing it without a refresh until something else triggers a load.
    const secondConnectionMessages = server.received
      .filter((r) => r.connection === 1)
      .map((r) => r.message.type);
    expect(secondConnectionMessages).not.toContain("list_sessions");
    expect(result.current.sessions).toHaveLength(1);
  });

  it("reloads the page when the server restarts with a new startup id", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const { result } = renderHook(() => useWebSocket(null));
    await waitFor(() => expect(result.current.connected).toBe(true));

    // The add-on restarted between the two connections.
    server.currentStartupId = "startup-b";
    server.dropAll();
    await waitFor(() => expect(result.current.connected).toBe(false));

    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000 });
  });

  it("does not reconnect after unmount (pending reconnect timer is cancelled)", async () => {
    const { result, unmount } = renderHook(() => useWebSocket(null));
    await waitFor(() => expect(result.current.connected).toBe(true));

    server.dropAll();
    await waitFor(() => expect(result.current.connected).toBe(false));
    unmount();

    // The reconnect timer would fire at ~2s. After unmount it must not
    // produce a zombie connection.
    await sleep(2600);
    expect(server.connectionCount).toBe(1);
  });

  it("unmounting while connecting does not leave a zombie reconnect", async () => {
    const { unmount } = renderHook(() => useWebSocket(null));
    // Unmount before the socket finishes opening.
    unmount();

    await sleep(2600);
    expect(server.connectionCount).toBeLessThanOrEqual(1);
  });
});
