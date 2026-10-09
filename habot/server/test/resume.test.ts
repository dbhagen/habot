import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAndResumeAwaitingSessions } from "../src/resume.js";
import { SessionDatabase } from "../src/database.js";
import type { AgentCallbacks } from "../src/agent.js";
import type { Config } from "../src/config.js";

/**
 * The resume boundary: after an add-on restart, sessions marked
 * awaiting_resume are resumed with a verification prompt and approvals are
 * granted automatically (no user is present). Drives the REAL
 * checkAndResumeAwaitingSessions against a disposable SQLite database; the
 * only faked boundary is AgentRunner.
 */
const agentHarness = vi.hoisted(() => {
  interface StartedQuery {
    prompt: string;
    resumeSessionId: string | null;
    callbacks: AgentCallbacks;
  }
  const state: { queries: StartedQuery[]; failNext: string | null } = {
    queries: [],
    failNext: null,
  };
  return { state };
});

vi.mock("../src/agent.js", () => {
  return {
    AgentRunner: class {
      runQuery(
        prompt: string,
        resumeSessionId: string | null,
        callbacks: AgentCallbacks,
      ): Promise<void> {
        agentHarness.state.queries.push({ prompt, resumeSessionId, callbacks });
        const failure = agentHarness.state.failNext;
        if (failure) {
          agentHarness.state.failNext = null;
          callbacks.onError(failure);
          return Promise.resolve();
        }
        callbacks.onComplete({
          text: "restart verified",
          toolCalls: [],
          sessionId: "agent-session-after-restart",
          usage: null,
          costUsd: null,
        });
        return Promise.resolve();
      }
    },
  };
});

const config: Config = {
  anthropicApiKey: "test-key-not-a-real-credential",
  haMcpUrl: "http://127.0.0.1:1/mcp", // unroutable loopback port, never dialed
  model: "test-model",
  supervisorToken: "",
  dataDir: "", // set in beforeEach
  port: 0,
  debugLogging: false,
};

let db: SessionDatabase;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "habot-resume-test-"));
  config.dataDir = dataDir;
  db = new SessionDatabase(dataDir);
  agentHarness.state.queries.length = 0;
  agentHarness.state.failNext = null;
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Build a session exactly the way a HA restart leaves one behind. */
function markAwaitingResume(agentSessionId: string | null): string {
  const session = db.createSession();
  if (agentSessionId) {
    db.updateSession(session.id, { agentSessionId });
  }
  db.setResumeContext(session.id, "Executed ha_restart to apply configuration changes.");
  return session.id;
}

/** Age the session's updated_at — addMessage stamps the session row. */
function backdateSession(id: string, minutesAgo: number): void {
  db.addMessage({
    id: `backdate-${id}`,
    sessionId: id,
    role: "system",
    content: "backdate",
    images: null,
    toolCalls: null,
    segments: null,
    tokenUsage: null,
    costUsd: null,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
}

describe("resume auto-approval boundary", () => {
  it("resumes an awaiting session after restart and auto-approves destructive tools (no user present)", async () => {
    const sessionId = markAwaitingResume("agent-session-1");

    await checkAndResumeAwaitingSessions(config, db);

    expect(agentHarness.state.queries).toHaveLength(1);
    const query = agentHarness.state.queries[0];
    expect(query.resumeSessionId).toBe("agent-session-1");
    expect(query.prompt).toContain("Home Assistant has restarted");
    expect(query.prompt).toContain("Executed ha_restart to apply configuration changes.");

    // THE boundary: during resume there is no user to ask — even a
    // destructive tool call is approved automatically.
    const decision = await query.callbacks.onApprovalNeeded(
      "tu-1",
      "mcp__ha-mcp__ha_call_service",
      { entity_id: "light.kitchen", domain: "light", service: "toggle" },
    );
    expect(decision).toEqual({ approved: true });

    // The resumed turn is recorded and the session returns to idle with the
    // fresh SDK session id stored for the next interactive turn.
    const messages = db.getMessages(sessionId);
    expect(messages.some((m) => m.role === "assistant" && m.content === "restart verified")).toBe(true);
    expect(db.getSession(sessionId)?.status).toBe("idle");
    expect(db.getSession(sessionId)?.agentSessionId).toBe("agent-session-after-restart");
  });

  it("does not auto-resume a fresh session that was never marked awaiting resume", async () => {
    const session = db.createSession();
    db.updateSession(session.id, { agentSessionId: "agent-session-2" });

    await checkAndResumeAwaitingSessions(config, db);

    expect(agentHarness.state.queries).toHaveLength(0);
    expect(db.getSession(session.id)?.status).toBe("active");
  });

  it("expires sessions awaiting resume beyond 10 minutes: marked idle with a notice, not resumed", async () => {
    const sessionId = markAwaitingResume("agent-session-3");
    backdateSession(sessionId, 11);

    await checkAndResumeAwaitingSessions(config, db);

    expect(agentHarness.state.queries).toHaveLength(0);
    expect(db.getSession(sessionId)?.status).toBe("idle");
    const messages = db.getMessages(sessionId);
    expect(messages.some((m) => m.role === "system" && m.content.includes("Resume timed out"))).toBe(true);
  });

  it("marks an awaiting-resume session without an agent session id as idle instead of resuming", async () => {
    const sessionId = markAwaitingResume(null);

    await checkAndResumeAwaitingSessions(config, db);

    expect(agentHarness.state.queries).toHaveLength(0);
    expect(db.getSession(sessionId)?.status).toBe("idle");
  });

  it("records a failed resume and parks the session idle for manual continuation", async () => {
    const sessionId = markAwaitingResume("agent-session-4");
    agentHarness.state.failNext = "model unavailable";

    await checkAndResumeAwaitingSessions(config, db);

    expect(db.getSession(sessionId)?.status).toBe("idle");
    const messages = db.getMessages(sessionId);
    expect(
      messages.some((m) => m.role === "system" && m.content.includes("Resume failed: model unavailable")),
    ).toBe(true);
  });
});
