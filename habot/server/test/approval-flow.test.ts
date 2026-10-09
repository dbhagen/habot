import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCallbacks } from "../src/agent.js";
import type { ToolCallInfo } from "../src/types.js";
import { TestClient, connectClient, startTestServer, type TestServer } from "./helpers.js";

/**
 * The approval flow lives in websocket.ts (pendingApprovals registry,
 * auto-approved tool set, status transitions, cancel auto-deny). Those are
 * real, unmocked code paths. The ONLY boundary faked here is AgentRunner —
 * the Anthropic SDK boundary — so tests can drive approvals synthetically
 * without Home Assistant or any Anthropic API call.
 */
const agentHarness = vi.hoisted(() => {
  interface StartedQuery {
    prompt: string;
    resumeSessionId: string | null;
    callbacks: AgentCallbacks;
    complete: (error?: string) => void;
    cancelCalls: number;
  }
  const queries: StartedQuery[] = [];
  return { queries };
});

vi.mock("../src/agent.js", () => {
  class AgentRunner {
    runQuery(
      prompt: string,
      resumeSessionId: string | null,
      callbacks: AgentCallbacks,
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        agentHarness.queries.push({
          prompt,
          resumeSessionId,
          callbacks,
          cancelCalls: 0,
          complete: (error?: string) => {
            if (error) reject(new Error(error));
            else resolve();
          },
        });
      });
    }
    cancel(): void {
      const current = agentHarness.queries[agentHarness.queries.length - 1];
      if (current) current.cancelCalls += 1;
    }
  }
  return { AgentRunner };
});

function latestQuery() {
  const query = agentHarness.queries[agentHarness.queries.length - 1];
  if (!query) throw new Error("no agent query started");
  return query;
}

async function waitForQueryCount(count: number): Promise<void> {
  await vi.waitFor(() => {
    if (agentHarness.queries.length !== count) {
      throw new Error(`expected ${count} agent queries, have ${agentHarness.queries.length}`);
    }
  });
}

const FAKE_API_KEY = "test-key-not-a-real-credential";
const TOOL = "mcp__ha-mcp__ha_call_service";
const TOOL_USE_ID = "tool-use-1";

function syntheticToolCall(id: string, status: ToolCallInfo["status"]): ToolCallInfo {
  return { id, name: TOOL, input: { entity_id: "light.kitchen" }, output: null, status };
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({ anthropicApiKey: FAKE_API_KEY });
});

afterEach(async () => {
  await server.close();
  agentHarness.queries.length = 0;
});

async function createSession(client: TestClient): Promise<string> {
  client.send({ type: "create_session" });
  const created = await client.waitForType("session_created");
  return created.session.id;
}

describe("approval flow", () => {
  it("requests approval for a destructive tool and resumes the turn when approved", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "toggle the kitchen light" });
    await waitForQueryCount(1);

    // Drive the real approval path: onToolUse then onApprovalNeeded, matching
    // the order the real agent emits them.
    const query = latestQuery();
    query.callbacks.onToolUse(syntheticToolCall(TOOL_USE_ID, "running"));
    const approval = query.callbacks.onApprovalNeeded(TOOL_USE_ID, TOOL, {
      entity_id: "light.kitchen",
      domain: "light",
      service: "toggle",
    });

    const approvalRequest = await client.waitForType("approval_request");
    expect(approvalRequest.sessionId).toBe(sessionId);
    expect(approvalRequest.toolUseId).toBe(TOOL_USE_ID);
    expect(approvalRequest.toolName).toBe(TOOL);
    expect(approvalRequest.input).toEqual({
      entity_id: "light.kitchen",
      domain: "light",
      service: "toggle",
    });

    const awaiting = await client.waitFor((m) => m.type === "status_update" && m.status === "awaiting_approval");
    expect(awaiting.toolName).toBe(TOOL);

    client.send({ type: "approve_tool", sessionId, toolUseId: TOOL_USE_ID, approved: true });
    await expect(approval).resolves.toEqual({ approved: true });

    // Agent finishes the turn after approval
    query.callbacks.onStreamText("Done, toggled.");
    query.callbacks.onComplete({
      text: "Done, toggled.",
      toolCalls: [syntheticToolCall(TOOL_USE_ID, "complete")],
      sessionId: "agent-session-abc",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.01,
    });

    const text = await client.waitForType("stream_text");
    expect(text.sessionId).toBe(sessionId);
    expect(text.text).toBe("Done, toggled.");

    await client.waitFor((m) => m.type === "status_update" && m.status === "responding");
    const turn = await client.waitForType("turn_complete");
    expect(turn.message.role).toBe("assistant");
    expect(turn.message.content).toBe("Done, toggled.");

    // Terminal idle status after the turn
    const idle = await client.waitFor((m) => m.type === "status_update" && m.status === "idle");
    expect(idle.startedAt).toBeNull();
    expect(idle.queueDepth).toBe(0);

    // The turn is durably recorded (real SQLite persistence)
    client.send({ type: "get_messages", sessionId });
    const messages = await client.waitForType("messages_list");
    expect(messages.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.messages[1].content).toBe("Done, toggled.");
    expect(messages.messages[1].costUsd).toBe(0.01);
    await client.close();
  });

  it("delivers a deny decision with the caller's message back to the agent", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "delete my automations" });
    await waitForQueryCount(1);
    const query = latestQuery();
    query.callbacks.onToolUse(syntheticToolCall(TOOL_USE_ID, "running"));
    const approval = query.callbacks.onApprovalNeeded(TOOL_USE_ID, TOOL, { entity_id: "automation.all" });
    await client.waitForType("approval_request");

    client.send({
      type: "approve_tool",
      sessionId,
      toolUseId: TOOL_USE_ID,
      approved: false,
      denyMessage: "Do not touch my automations",
    });
    await expect(approval).resolves.toEqual({ approved: false, denyMessage: "Do not touch my automations" });
    await client.close();
  });

  it("auto-approves later calls of the same tool after 'allow and always' approval", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "toggle lights twice" });
    await waitForQueryCount(1);
    const query = latestQuery();

    // First call requires approval
    query.callbacks.onToolUse(syntheticToolCall("tu-1", "running"));
    const firstApproval = query.callbacks.onApprovalNeeded("tu-1", TOOL, { entity_id: "light.kitchen" });
    await client.waitForType("approval_request");
    client.send({ type: "approve_tool", sessionId, toolUseId: "tu-1", approved: true, autoApprove: true });
    await expect(firstApproval).resolves.toEqual({ approved: true });

    // Second call of the SAME tool is auto-approved server-side: no approval_request
    query.callbacks.onToolUse(syntheticToolCall("tu-2", "running"));
    const secondApproval = query.callbacks.onApprovalNeeded("tu-2", TOOL, { entity_id: "light.office" });
    await expect(secondApproval).resolves.toEqual({ approved: true });
    await TestClient.expectSilence(300);
    expect(client.count("approval_request")).toBe(1);

    // A DIFFERENT tool still requires explicit approval
    const otherTool = "mcp__ha-mcp__ha_restart";
    query.callbacks.onToolUse({ id: "tu-3", name: otherTool, input: {}, output: null, status: "running" });
    const thirdApproval = query.callbacks.onApprovalNeeded("tu-3", otherTool, {});
    await client.waitFor((m) => m.type === "approval_request" && m.toolUseId === "tu-3");
    expect(client.count("approval_request")).toBe(2);
    client.send({ type: "approve_tool", sessionId, toolUseId: "tu-3", approved: false });
    await expect(thirdApproval).resolves.toEqual({ approved: false, denyMessage: undefined });
    await client.close();
  });

  it("masks secret-like values in the approval request sent to the client", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "call a service" });
    await waitForQueryCount(1);
    const query = latestQuery();
    query.callbacks.onToolUse(syntheticToolCall(TOOL_USE_ID, "running"));
    const approval = query.callbacks.onApprovalNeeded(TOOL_USE_ID, TOOL, {
      entity_id: "light.kitchen",
      // Synthetic token — matches the Bearer pattern mask-secrets.ts detects
      authorization: "Bearer " + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    });
    await client.waitForType("approval_request");
    // Deny so the pending promise does not leak
    client.send({ type: "approve_tool", sessionId, toolUseId: TOOL_USE_ID, approved: false });
    await approval;

    const request = client.all().find((m) => m.type === "approval_request");
    if (request?.type !== "approval_request") throw new Error("unreachable");
    const input = request.input as { authorization: string };
    expect(input.authorization).not.toContain("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6");
    expect(input.authorization).toMatch(/\(\d+ chars\)$/);
    await client.close();
  });

  it("cancel while awaiting approval auto-denies the pending tool, clears state and aborts the agent", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "restart home assistant" });
    await waitForQueryCount(1);
    const query = latestQuery();
    query.callbacks.onToolUse(syntheticToolCall(TOOL_USE_ID, "running"));
    const approval = query.callbacks.onApprovalNeeded(TOOL_USE_ID, TOOL, {});
    await client.waitForType("approval_request");

    client.send({ type: "cancel", sessionId });

    // Pending approval is auto-denied
    await expect(approval).resolves.toEqual({ approved: false });
    // Queue is cleared and cancelling status is announced
    await client.waitForType("queue_cleared");
    await client.waitFor((m) => m.type === "status_update" && m.status === "cancelling");
    // The agent was asked to abort
    expect(query.cancelCalls).toBe(1);

    // Agent honors the abort by completing; server must signal cancel_complete + idle
    query.callbacks.onComplete({
      text: "cancelled",
      toolCalls: [],
      sessionId: "agent-session-abc",
      usage: null,
      costUsd: null,
    });
    await client.waitForType("cancel_complete");
    await client.waitFor((m) => m.type === "status_update" && m.status === "idle");
    await client.close();
  });

  it("queues messages sent while a turn is active and drains them on completion", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "first message" });
    await waitForQueryCount(1);
    const firstQuery = latestQuery();
    firstQuery.callbacks.onToolUse(syntheticToolCall(TOOL_USE_ID, "running"));
    const firstApproval = firstQuery.callbacks.onApprovalNeeded(TOOL_USE_ID, TOOL, {});
    await client.waitForType("approval_request");

    // Second message while busy → queued, not a new agent turn
    client.send({ type: "send_message", sessionId, content: "second message" });
    const queued = await client.waitForType("message_queued");
    expect(queued.position).toBe(1);
    await client.waitFor((m) => m.type === "status_update" && m.queueDepth === 1);
    expect(agentHarness.queries).toHaveLength(1);

    // Approve and finish the first turn
    client.send({ type: "approve_tool", sessionId, toolUseId: TOOL_USE_ID, approved: true });
    await firstApproval;
    firstQuery.callbacks.onComplete({
      text: "first done",
      toolCalls: [],
      sessionId: "agent-session-abc",
      usage: null,
      costUsd: null,
    });
    await client.waitForType("turn_complete");

    // Queue drains: second agent query starts with the queued content
    await waitForQueryCount(2);
    expect(latestQuery().prompt).toBe("second message");
    await client.waitFor((m) => m.type === "status_update" && m.status === "thinking");

    latestQuery().callbacks.onComplete({
      text: "second done",
      toolCalls: [],
      sessionId: "agent-session-abc",
      usage: null,
      costUsd: null,
    });
    const secondTurn = await client.waitFor((m) => m.type === "turn_complete" && m.message.content === "second done");
    expect(secondTurn.message.content).toBe("second done");
    await client.close();
  });

  it("clears queued messages on agent error and resets to idle", async () => {
    const client = await connectClient(server.port);
    await client.waitForType("server_hello");
    const sessionId = await createSession(client);

    client.send({ type: "send_message", sessionId, content: "message one" });
    await waitForQueryCount(1);
    client.send({ type: "send_message", sessionId, content: "message two" });
    await client.waitForType("message_queued");

    latestQuery().callbacks.onError("model exploded");
    const err = await client.waitForType("error");
    expect(err.sessionId).toBe(sessionId);
    expect(err.message).toBe("model exploded");
    await client.waitForType("queue_cleared");
    await client.waitFor((m) => m.type === "status_update" && m.status === "idle");
    await client.close();
  });
});
