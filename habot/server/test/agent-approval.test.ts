import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, type AgentCallbacks } from "../src/agent.js";
import type { Config } from "../src/config.js";
import type { ChatMessage } from "../src/types.js";

/**
 * Drives the REAL canUseTool classification in agent.ts: read-only
 * auto-approval, destructive-tool escalation to the user, deny message
 * formatting, the built-in-tool input echo, and the stale-session resume
 * retry. The only faked boundary is the Agent SDK's `query` — it captures
 * the options passed by agent.ts (including canUseTool) and ends the turn
 * with a synthetic result. No network, no Home Assistant.
 */
const sdkHarness = vi.hoisted(() => {
  const state: {
    options: Record<string, unknown> | null;
    calls: number;
    failOnCall: { call: number; message: string } | null;
  } = { options: null, calls: 0, failOnCall: null };
  return { state };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { options: Record<string, unknown> }) => {
    sdkHarness.state.calls += 1;
    const fail = sdkHarness.state.failOnCall;
    if (fail && fail.call === sdkHarness.state.calls) {
      throw new Error(fail.message);
    }
    sdkHarness.state.options = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", session_id: "sdk-session-1", total_cost_usd: 0 };
    })();
  },
}));

const config: Config = {
  anthropicApiKey: "test-key-not-a-real-credential",
  haMcpUrl: "http://127.0.0.1:1/mcp", // unroutable loopback port, never dialed
  model: "test-model",
  supervisorToken: "",
  dataDir: "/tmp/habot-agent-approval-test-unused",
  port: 0,
  debugLogging: false,
};

type CanUseToolDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

type CanUseTool = (
  toolName: string,
  input: unknown,
  context: { toolUseID: string },
) => Promise<CanUseToolDecision>;

/** Synthetic chat message with sensible defaults for history fixtures. */
function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    sessionId: "s1",
    role,
    content,
    images: null,
    toolCalls: null,
    segments: null,
    tokenUsage: null,
    costUsd: null,
    timestamp: "2026-10-09T00:00:00.000Z",
  };
}

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onStreamText: vi.fn(),
    onToolUse: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onApprovalNeeded: vi.fn(async () => ({ approved: true })),
    onRestartDetected: vi.fn(),
    ...overrides,
  };
}

async function startAgent(
  callbacks: AgentCallbacks,
  resumeSessionId: string | null = null,
): Promise<CanUseTool> {
  const agent = new AgentRunner(config);
  await agent.runQuery("do something", resumeSessionId, callbacks);
  const options = sdkHarness.state.options;
  if (!options || typeof options.canUseTool !== "function") {
    throw new Error("SDK query was not invoked with a canUseTool callback");
  }
  return options.canUseTool as CanUseTool;
}

beforeEach(() => {
  sdkHarness.state.options = null;
  sdkHarness.state.calls = 0;
  sdkHarness.state.failOnCall = null;
});

describe("canUseTool classification", () => {
  it("auto-approves read-only MCP tools without consulting the user", async () => {
    const callbacks = makeCallbacks();
    const canUseTool = await startAgent(callbacks);

    const decision = await canUseTool(
      "mcp__ha-mcp__ha_get_entity_state",
      { entity_id: "light.kitchen" },
      { toolUseID: "t1" },
    );

    expect(decision).toEqual({ behavior: "allow" });
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });

  it("allows built-in read-only tools with the input echoed back (SDK contract)", async () => {
    const canUseTool = await startAgent(makeCallbacks());
    const input = { pattern: "**/*.yaml" };

    const decision = await canUseTool("Glob", input, { toolUseID: "t2" });

    expect(decision).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("routes destructive tools through the user and allows when approved", async () => {
    const callbacks = makeCallbacks();
    const canUseTool = await startAgent(callbacks);
    const input = { entity_id: "light.kitchen", domain: "light", service: "toggle" };

    const decision = await canUseTool("mcp__ha-mcp__ha_call_service", input, { toolUseID: "t3" });

    expect(callbacks.onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(callbacks.onApprovalNeeded).toHaveBeenCalledWith("t3", "mcp__ha-mcp__ha_call_service", input);
    expect(decision).toEqual({ behavior: "allow" });
  });

  it("allows a destructive built-in tool with the input echoed back when approved", async () => {
    const canUseTool = await startAgent(makeCallbacks());
    const input = { command: "ha core check" };

    const decision = await canUseTool("Bash", input, { toolUseID: "t4" });

    expect(decision).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("denies the tool call when the user declines", async () => {
    const callbacks = makeCallbacks({
      onApprovalNeeded: async () => ({ approved: false }),
    });
    const canUseTool = await startAgent(callbacks);

    const decision = await canUseTool("Bash", { command: "rm -rf /" }, { toolUseID: "t5" });

    expect(decision).toEqual({ behavior: "deny", message: "User denied this operation." });
    expect(callbacks.onRestartDetected).not.toHaveBeenCalled();
  });

  it("passes the user's deny instructions through to the agent", async () => {
    const callbacks = makeCallbacks({
      onApprovalNeeded: async () => ({ approved: false, denyMessage: "ask me first" }),
    });
    const canUseTool = await startAgent(callbacks);

    const decision = await canUseTool("Edit", { path: "/config/configuration.yaml" }, { toolUseID: "t6" });

    expect(decision).toEqual({ behavior: "deny", message: "User instruction: ask me first" });
  });

  it("notifies the restart hook when an approved tool restarts Home Assistant", async () => {
    const callbacks = makeCallbacks();
    const canUseTool = await startAgent(callbacks);

    const decision = await canUseTool("mcp__ha-mcp__ha_restart", {}, { toolUseID: "t7" });

    expect(decision).toEqual({ behavior: "allow" });
    expect(callbacks.onRestartDetected).toHaveBeenCalledTimes(1);
    expect(callbacks.onRestartDetected).toHaveBeenCalledWith("mcp__ha-mcp__ha_restart");
  });

  it("allows unclassified MCP tools by default without consulting the user", async () => {
    const callbacks = makeCallbacks();
    const canUseTool = await startAgent(callbacks);

    const decision = await canUseTool("mcp__ha-mcp__ha_brand_new_tool", {}, { toolUseID: "t8" });

    expect(decision).toEqual({ behavior: "allow" });
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
  });
});

describe("stale-session resume retry", () => {
  it("retries a failed resume without the stale session id and injects history instead", async () => {
    sdkHarness.state.failOnCall = {
      call: 1,
      message: "No conversation found with session ID: stale-123",
    };
    const callbacks = makeCallbacks();
    // Realistic history: handleSendMessage persists the current prompt before
    // fetching history, so the last entry mirrors the prompt being sent.
    const history: ChatMessage[] = [
      msg("m1", "user", "turn on the lights"),
      msg("m2", "assistant", "Done — the kitchen light is on."),
      msg("m3", "user", "did it work?"),
    ];
    const agent = new AgentRunner(config);

    await agent.runQuery("did it work?", "stale-123", callbacks, null, history);

    // First query failed with the stale id; the second ran without resume.
    expect(sdkHarness.state.calls).toBe(2);
    const retried = sdkHarness.state.options as { resume?: string; systemPrompt?: string };
    expect(retried.resume).toBeUndefined();
    // Without an SDK session to resume, prior context is injected into the system prompt.
    expect(String(retried.systemPrompt)).toContain("Conversation History");
    expect(String(retried.systemPrompt)).toContain("turn on the lights");
    expect(String(retried.systemPrompt)).toContain("Done — the kitchen light is on.");
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("does not retry when there is no resume session to fall back from", async () => {
    sdkHarness.state.failOnCall = {
      call: 1,
      message: "No conversation found with session ID: whatever",
    };
    const callbacks = makeCallbacks();
    const agent = new AgentRunner(config);

    await agent.runQuery("hello", null, callbacks);

    expect(sdkHarness.state.calls).toBe(1);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });
});
