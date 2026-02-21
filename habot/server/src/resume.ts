import type { Config } from "./config.js";
import type { SessionDatabase } from "./database.js";
import { AgentRunner } from "./agent.js";
import { randomUUID } from "node:crypto";
import { debug } from "./logger.js";
import { maskSecrets, maskSecretsInObject } from "./mask-secrets.js";

const RESUME_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * On startup, check for sessions that were awaiting resume (e.g., after HA restart).
 * Resume them sequentially with a verification prompt.
 */
export async function checkAndResumeAwaitingSessions(
  config: Config,
  db: SessionDatabase,
): Promise<void> {
  const sessions = db.getAwaitingResumeSessions();

  if (sessions.length === 0) {
    debug("resume", "no sessions awaiting resume");
    return;
  }

  debug("resume", `found ${sessions.length} session(s) awaiting resume`, {
    ids: sessions.map((s) => s.id),
  });

  for (const session of sessions) {
    // Check TTL — if the session has been awaiting resume for too long, mark idle
    const updatedAt = new Date(session.updatedAt).getTime();
    const elapsed = Date.now() - updatedAt;

    if (elapsed > RESUME_TTL_MS) {
      debug("resume", `session ${session.id} exceeded TTL (${Math.round(elapsed / 1000)}s), marking idle`);
      db.updateSession(session.id, { status: "idle" });

      db.addMessage({
        id: randomUUID(),
        sessionId: session.id,
        role: "system",
        content: "Resume timed out. The session was awaiting resume for over 10 minutes. You can continue the conversation manually.",
        images: null,
        toolCalls: null,
        segments: null,
        tokenUsage: null,
        costUsd: null,
        timestamp: new Date().toISOString(),
      });

      continue;
    }

    if (!session.agentSessionId) {
      debug("resume", `session ${session.id} has no agent session ID, marking idle`);
      db.updateSession(session.id, { status: "idle" });
      continue;
    }

    debug("resume", `resuming session ${session.id}`, {
      agentSessionId: session.agentSessionId,
      resumeContext: session.resumeContext,
      elapsedMs: elapsed,
    });

    try {
      const agent = new AgentRunner(config);
      const resumePrompt = `Home Assistant has restarted. ${session.resumeContext} Please verify that the changes took effect and report the results.`;

      await new Promise<void>((resolve, reject) => {
        agent.runQuery(resumePrompt, session.agentSessionId, {
          onStreamText: () => {},
          onToolUse: () => {},
          onComplete: (result) => {
            // Persist the resume response (masked for storage)
            const maskedToolCalls = result.toolCalls.length > 0
              ? result.toolCalls.map((tc) => ({
                  ...tc,
                  input: maskSecretsInObject(tc.input),
                  output: maskSecretsInObject(tc.output),
                }))
              : null;

            db.addMessage({
              id: randomUUID(),
              sessionId: session.id,
              role: "assistant",
              content: maskSecrets(result.text),
              images: null,
              toolCalls: maskedToolCalls,
              segments: null,
              tokenUsage: result.usage,
              costUsd: result.costUsd,
              timestamp: new Date().toISOString(),
            });

            db.updateSession(session.id, {
              status: "idle",
              agentSessionId: result.sessionId || undefined,
            });

            debug("resume", `session ${session.id} resumed successfully`, {
              textLength: result.text.length,
              toolCallCount: result.toolCalls.length,
              costUsd: result.costUsd,
            });
            resolve();
          },
          onError: (error) => {
            debug("resume", `session ${session.id} resume failed: ${error}`);
            db.updateSession(session.id, { status: "idle" });
            db.addMessage({
              id: randomUUID(),
              sessionId: session.id,
              role: "system",
              content: `Resume failed: ${error}. You can continue the conversation manually.`,
              images: null,
              toolCalls: null,
              segments: null,
              tokenUsage: null,
              costUsd: null,
              timestamp: new Date().toISOString(),
            });
            reject(new Error(error));
          },
          // Auto-approve during resume (no user present)
          onApprovalNeeded: async () => {
            debug("resume", `auto-approving tool during resume for session ${session.id}`);
            return { approved: true };
          },
        });
      });
    } catch {
      // Already handled in onError callback
    }
  }
}
