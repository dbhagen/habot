import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_STARTUP_ID,
  TestClient,
  connectClient,
  startTestServer,
  type TestServer,
} from "./helpers.js";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe("websocket handshake", () => {
  it("sends server_hello with the startup id on connect", async () => {
    const client = await connectClient(server.port);
    const hello = await client.waitForType("server_hello");
    expect(hello).toEqual({ type: "server_hello", startupId: TEST_STARTUP_ID });
    await client.close();
  });

  it("accepts multiple concurrent clients, each greeted independently", async () => {
    const a = await connectClient(server.port);
    const b = await connectClient(server.port);
    expect((await a.waitForType("server_hello")).startupId).toBe(TEST_STARTUP_ID);
    expect((await b.waitForType("server_hello")).startupId).toBe(TEST_STARTUP_ID);
    await a.close();
    await b.close();
  });
});

describe("session lifecycle over websocket", () => {
  it("create_session returns a fully-shaped new session", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "create_session" });
    const reply = await client.waitForType("session_created");
    const session = reply.session;
    expect(session.name).toBe("New Chat");
    expect(session.status).toBe("active");
    expect(session.agentSessionId).toBeNull();
    expect(session.id).toMatch(/[0-9a-f-]{36}/);
    expect(Date.parse(session.createdAt)).not.toBeNaN();
    await client.close();
  });

  it("list_sessions reflects created, renamed and archived sessions", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");

    client.send({ type: "create_session" });
    const created = await client.waitForType("session_created");

    client.send({ type: "rename_session", sessionId: created.session.id, name: "Kitchen lights" });
    const renamed = await client.waitForType("session_updated");
    expect(renamed.session.name).toBe("Kitchen lights");

    client.send({ type: "list_sessions" });
    const listed = await client.waitForType("sessions_list");
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].name).toBe("Kitchen lights");

    client.send({ type: "archive_session", sessionId: created.session.id });
    const deleted = await client.waitForType("session_deleted");
    expect(deleted.sessionId).toBe(created.session.id);

    client.send({ type: "list_sessions" });
    const afterArchive = await client.waitFor((m) => m.type === "sessions_list" && m.sessions.length === 0);
    expect(afterArchive.sessions).toHaveLength(0);
    await client.close();
  });

  it("delete_session confirms with session_deleted and removes the session", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "create_session" });
    const created = await client.waitForType("session_created");
    client.send({ type: "delete_session", sessionId: created.session.id });
    expect((await client.waitForType("session_deleted")).sessionId).toBe(created.session.id);
    client.send({ type: "list_sessions" });
    const listed = await client.waitForType("sessions_list");
    expect(listed.sessions).toHaveLength(0);
    await client.close();
  });

  it("get_messages for an unknown session returns an empty list, not an error", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "get_messages", sessionId: "00000000-0000-0000-0000-000000000000" });
    const reply = await client.waitForType("messages_list");
    expect(reply.messages).toEqual([]);
    await client.close();
  });

  it("rename_session for an unknown session sends no session_updated (pinned current behavior)", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "rename_session", sessionId: "nope", name: "ghost" });
    await TestClient.expectSilence(300);
    expect(client.count("session_updated")).toBe(0);
    await client.close();
  });
});

describe("malformed input", () => {
  it("replies with a sessionless error to invalid JSON and keeps the connection open", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.ws.send("this is not json {{{");
    const err = await client.waitForType("error");
    expect(err.sessionId).toBeNull();
    expect(err.message).toBe("Invalid JSON");

    // connection still usable afterwards
    client.send({ type: "create_session" });
    await client.waitForType("session_created");
    await client.close();
  });

  it("ignores messages with unknown types (pinned current behavior: no error reply)", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "bogus_action", payload: { x: 1 } });
    await TestClient.expectSilence(300);
    expect(client.count("error")).toBe(0);
    // and the connection still works
    client.send({ type: "create_session" });
    await client.waitForType("session_created");
    await client.close();
  });
});

describe("send_message without Anthropic credentials", () => {
  it("rejects with a configuration error naming the fix, and does not persist the message", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    client.send({ type: "create_session" });
    const created = await client.waitForType("session_created");
    client.send({ type: "send_message", sessionId: created.session.id, content: "turn on the lights" });
    const err = await client.waitForType("error");
    expect(err.sessionId).toBe(created.session.id);
    expect(err.message).toContain("Anthropic API key not configured");

    // Current behavior (pinned): the API-key guard runs BEFORE persistence, so
    // the message is dropped from history. The user must re-send after
    // configuring the key.
    client.send({ type: "get_messages", sessionId: created.session.id });
    const messages = await client.waitForType("messages_list");
    expect(messages.messages).toHaveLength(0);
    await client.close();
  });
});

describe("connection cleanup", () => {
  it("survives abrupt client termination and keeps serving other clients", async () => {
    const a = await connectClient(server.port);
    await a.waitForType("server_hello");
    const b = await connectClient(server.port);
    await b.waitForType("server_hello");

    a.terminate(); // no close handshake
    await a.closed;
    await TestClient.expectSilence(100);

    b.send({ type: "create_session" });
    await b.waitForType("session_created");
    await b.close();
  });

  it("persists sessions created by a disconnected client for the next one", async () => {
    const first = await connectClient(server.port);
    await first.waitForType("server_hello");
    first.send({ type: "create_session" });
    const created = await first.waitForType("session_created");
    await first.close();

    const second = await connectClient(server.port);
    await second.waitForType("server_hello");
    second.send({ type: "list_sessions" });
    const listed = await second.waitForType("sessions_list");
    expect(listed.sessions.map((s) => s.id)).toContain(created.session.id);
    await second.close();
  });
});
