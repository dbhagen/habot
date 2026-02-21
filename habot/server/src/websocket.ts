import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Config } from "./config.js";
import type { ClientMessage, ServerMessage, ChatMessage, AgentStatus, ImageAttachment, MessageSegment } from "./types.js";
import type { SessionDatabase } from "./database.js";
import { AgentRunner } from "./agent.js";
import { randomUUID } from "node:crypto";
import { debug } from "./logger.js";
import { maskSecrets, maskSecretsInObject } from "./mask-secrets.js";

interface QueuedMessage {
  id: string;
  content: string;
  images?: ImageAttachment[] | null;
}

interface ApprovalResult {
  approved: boolean;
  autoApprove?: boolean;
  denyMessage?: string;
}

interface ActiveSession {
  agent: AgentRunner;
  pendingApprovals: Map<string, (result: ApprovalResult) => void>;
  autoApprovedTools: Set<string>;
  queue: QueuedMessage[];
  status: AgentStatus;
  startedAt: string | null;
  currentToolName: string | null;
  cancelTimeout: ReturnType<typeof setTimeout> | null;
}

export function setupWebSocket(server: Server, config: Config, db: SessionDatabase, startupId: string): void {
  const wss = new WebSocketServer({ server });
  const activeSessions = new Map<string, ActiveSession>();

  wss.on("connection", (ws) => {
    debug("ws", "client connected");

    // Send startup ID so the frontend can detect add-on restarts
    send(ws, { type: "server_hello", startupId });

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        debug("ws", "received invalid JSON from client");
        send(ws, { type: "error", sessionId: null, message: "Invalid JSON" });
        return;
      }

      debug("ws", `received message type=${msg.type}${"sessionId" in msg ? ` session=${(msg as { sessionId: string }).sessionId}` : ""}`);
      handleMessage(ws, msg, config, db, activeSessions);
    });

    ws.on("close", () => {
      debug("ws", "client disconnected");
    });

    ws.on("error", (err) => {
      debug("ws", `client error: ${err.message}`);
    });
  });
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    debug("ws", `sending type=${msg.type}${"sessionId" in msg ? ` session=${(msg as { sessionId: string }).sessionId}` : ""}`);
    ws.send(JSON.stringify(msg));
  }
}

function sendStatusUpdate(ws: WebSocket, sessionId: string, active: ActiveSession): void {
  send(ws, {
    type: "status_update",
    sessionId,
    status: active.status,
    toolName: active.currentToolName,
    startedAt: active.startedAt,
    queueDepth: active.queue.length,
  });
}

function handleMessage(
  ws: WebSocket,
  msg: ClientMessage,
  config: Config,
  db: SessionDatabase,
  activeSessions: Map<string, ActiveSession>,
): void {
  switch (msg.type) {
    case "send_message":
      handleSendMessage(ws, msg.sessionId, msg.content, config, db, activeSessions, msg.images);
      break;

    case "cancel": {
      debug("ws", `cancel requested for session=${msg.sessionId}`);
      const session = activeSessions.get(msg.sessionId);
      if (session) {
        // 1. Clear queue
        session.queue = [];
        send(ws, { type: "queue_cleared", sessionId: msg.sessionId });

        // 2. Set cancelling status
        session.status = "cancelling";
        session.currentToolName = null;
        sendStatusUpdate(ws, msg.sessionId, session);

        // 3. Auto-deny all pending approvals (unblocks agent if stuck)
        for (const [toolUseId, resolver] of session.pendingApprovals) {
          debug("ws", `auto-denying pending approval toolUseId=${toolUseId} due to cancel`);
          resolver({ approved: false });
        }
        session.pendingApprovals.clear();

        // 4. Abort the agent
        session.agent.cancel();
        debug("ws", `cancelled agent for session=${msg.sessionId}`);

        // 5. Force-cleanup timeout (10s)
        if (session.cancelTimeout) clearTimeout(session.cancelTimeout);
        session.cancelTimeout = setTimeout(() => {
          debug("ws", `force-cleanup timeout for session=${msg.sessionId}`);
          activeSessions.delete(msg.sessionId);
          send(ws, { type: "cancel_complete", sessionId: msg.sessionId });
          send(ws, {
            type: "status_update",
            sessionId: msg.sessionId,
            status: "idle",
            toolName: null,
            startedAt: null,
            queueDepth: 0,
          });
        }, 10_000);
      } else {
        debug("ws", `no active session found for cancel session=${msg.sessionId}`);
      }
      break;
    }

    case "approve_tool": {
      debug("ws", `tool approval response session=${msg.sessionId} toolUseId=${msg.toolUseId} approved=${msg.approved} autoApprove=${msg.autoApprove ?? false}`);
      const session = activeSessions.get(msg.sessionId);
      if (session) {
        const resolver = session.pendingApprovals.get(msg.toolUseId);
        if (resolver) {
          // If auto-approve requested, find the tool name from the pending approval context and add to set
          if (msg.approved && msg.autoApprove) {
            // We need to find the tool name — it's stored in the approval request context
            // The tool name is available from the currentToolName on the session
            if (session.currentToolName) {
              session.autoApprovedTools.add(session.currentToolName);
              debug("ws", `auto-approve enabled for tool=${session.currentToolName} session=${msg.sessionId}`);
            }
          }
          resolver({ approved: msg.approved, autoApprove: msg.autoApprove, denyMessage: msg.denyMessage });
          session.pendingApprovals.delete(msg.toolUseId);
        } else {
          debug("ws", `no pending approval found for toolUseId=${msg.toolUseId}`);
        }
      }
      break;
    }

    case "create_session": {
      debug("ws", "creating new session");
      const session = db.createSession();
      send(ws, { type: "session_created", session });
      break;
    }

    case "list_sessions": {
      debug("ws", "listing sessions");
      const sessions = db.listSessions();
      debug("ws", `returning ${sessions.length} sessions`);
      send(ws, { type: "sessions_list", sessions });
      break;
    }

    case "get_messages": {
      debug("ws", `loading messages for session=${msg.sessionId}`);
      const messages = db.getMessages(msg.sessionId);
      debug("ws", `returning ${messages.length} messages for session=${msg.sessionId}`);
      send(ws, { type: "messages_list", sessionId: msg.sessionId, messages });
      break;
    }

    case "rename_session": {
      debug("ws", `renaming session=${msg.sessionId} to "${msg.name}"`);
      const updated = db.updateSession(msg.sessionId, { name: msg.name });
      if (updated) {
        send(ws, { type: "session_updated", session: updated });
      }
      break;
    }

    case "delete_session": {
      debug("ws", `deleting session=${msg.sessionId}`);
      db.deleteSession(msg.sessionId);
      send(ws, { type: "session_deleted", sessionId: msg.sessionId });
      break;
    }

    case "archive_session": {
      debug("ws", `archiving session=${msg.sessionId}`);
      db.archiveSession(msg.sessionId);
      send(ws, { type: "session_deleted", sessionId: msg.sessionId });
      break;
    }
  }
}

function handleSendMessage(
  ws: WebSocket,
  sessionId: string,
  content: string,
  config: Config,
  db: SessionDatabase,
  activeSessions: Map<string, ActiveSession>,
  images?: ImageAttachment[],
): void {
  debug("ws", `handleSendMessage session=${sessionId}`, {
    apiKeyPresent: !!config.anthropicApiKey,
    apiKeyPrefix: config.anthropicApiKey ? config.anthropicApiKey.substring(0, 12) + "..." : "none",
    mcpUrl: config.haMcpUrl,
    model: config.model,
    contentLength: content.length,
    imageCount: images?.length ?? 0,
  });

  if (!config.anthropicApiKey) {
    send(ws, {
      type: "error",
      sessionId,
      message: "Anthropic API key not configured. Please set it in the add-on configuration.",
    });
    return;
  }

  // Persist user message
  const messageImages = images && images.length > 0 ? images : null;
  const userMessage: ChatMessage = {
    id: randomUUID(),
    sessionId,
    role: "user",
    content,
    images: messageImages,
    toolCalls: null,
    segments: null,
    tokenUsage: null,
    costUsd: null,
    timestamp: new Date().toISOString(),
  };
  db.addMessage({ ...userMessage, content: maskSecrets(userMessage.content) });

  // Auto-name session from first message
  db.autoNameSession(sessionId, content);

  // Check if session is already processing — queue if so
  const existing = activeSessions.get(sessionId);
  if (existing && existing.status !== "idle") {
    const queued: QueuedMessage = { id: userMessage.id, content, images: messageImages };
    existing.queue.push(queued);
    const position = existing.queue.length;
    debug("ws", `message queued session=${sessionId} position=${position}`, { contentLength: content.length });
    send(ws, { type: "message_queued", sessionId, messageId: userMessage.id, position });
    sendStatusUpdate(ws, sessionId, existing);
    return;
  }

  // Start agent turn
  startAgentTurn(ws, sessionId, content, config, db, activeSessions, messageImages);
}

function startAgentTurn(
  ws: WebSocket,
  sessionId: string,
  content: string,
  config: Config,
  db: SessionDatabase,
  activeSessions: Map<string, ActiveSession>,
  images?: ImageAttachment[] | null,
): void {
  // Get agent session ID for resume and load conversation history
  const session = db.getSession(sessionId);
  const existingAgentSessionId = session?.agentSessionId ?? null;
  const conversationHistory = db.getMessages(sessionId);
  debug("ws", `startAgentTurn session=${sessionId}`, {
    hasAgentSessionId: !!existingAgentSessionId,
    historyMessageCount: conversationHistory.length,
  });

  const agent = new AgentRunner(config);
  const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();

  // Preserve queue and auto-approved tools from previous turn if exists
  const previousActive = activeSessions.get(sessionId);
  const existingQueue = previousActive?.queue ?? [];
  const existingAutoApproved = previousActive?.autoApprovedTools ?? new Set<string>();

  const active: ActiveSession = {
    agent,
    pendingApprovals,
    autoApprovedTools: existingAutoApproved,
    queue: existingQueue,
    status: "thinking",
    startedAt: new Date().toISOString(),
    currentToolName: null,
    cancelTimeout: null,
  };
  activeSessions.set(sessionId, active);

  // Send initial thinking status
  sendStatusUpdate(ws, sessionId, active);

  // Track interleaved segments for preserving text/tool order in final message
  const segments: MessageSegment[] = [];
  const seenToolIds = new Set<string>();

  agent.runQuery(content, existingAgentSessionId, {
    onStreamText: (text) => {
      if (active.status !== "responding" && active.status !== "cancelling") {
        active.status = "responding";
        active.currentToolName = null;
        sendStatusUpdate(ws, sessionId, active);
      }
      // Append to last text segment or create a new one
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.type === "text") {
        lastSeg.text += text;
      } else {
        segments.push({ type: "text", text });
      }
      send(ws, { type: "stream_text", sessionId, text: maskSecrets(text) });
    },

    onToolUse: (toolCall) => {
      if (toolCall.status === "running" && active.status !== "cancelling") {
        active.status = "tool_use";
        active.currentToolName = toolCall.name;
        sendStatusUpdate(ws, sessionId, active);
      }
      // Track new tool calls in segments (not updates to existing ones)
      if (!seenToolIds.has(toolCall.id)) {
        seenToolIds.add(toolCall.id);
        segments.push({ type: "tool", toolCallId: toolCall.id });
      }
      const maskedToolCall = {
        ...toolCall,
        input: maskSecretsInObject(toolCall.input),
        output: maskSecretsInObject(toolCall.output),
      };
      send(ws, { type: "stream_tool_use", sessionId, toolCall: maskedToolCall });
    },

    onRestartDetected: (toolName) => {
      const context = `Executed ${toolName.replace("mcp__ha-mcp__", "")} to apply configuration changes.`;
      db.setResumeContext(sessionId, context);
      debug("ws", `restart detected, session marked for resume`, { sessionId, toolName, context });
    },

    onComplete: (result) => {
      debug("ws", `turn complete`, {
        sessionId,
        agentSessionId: result.sessionId,
        toolCallCount: result.toolCalls.length,
        textLength: result.text.length,
        costUsd: result.costUsd,
      });

      // Clear force-cleanup timeout if set
      if (active.cancelTimeout) {
        clearTimeout(active.cancelTimeout);
        active.cancelTimeout = null;
      }

      // Store agent session ID for future resume
      db.updateSession(sessionId, {
        agentSessionId: result.sessionId || undefined,
        status: "idle",
      });

      // Build masked copy for DB storage and WS send
      const maskedToolCalls = result.toolCalls.length > 0
        ? result.toolCalls.map((tc) => ({
            ...tc,
            input: maskSecretsInObject(tc.input),
            output: maskSecretsInObject(tc.output),
          }))
        : null;

      // Build masked segments (mask text segments)
      const maskedSegments = segments.length > 0
        ? segments.map((seg) =>
            seg.type === "text" ? { ...seg, text: maskSecrets(seg.text) } : seg
          )
        : null;

      const message: ChatMessage = {
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: maskSecrets(result.text),
        images: null,
        toolCalls: maskedToolCalls,
        segments: maskedSegments,
        tokenUsage: result.usage,
        costUsd: result.costUsd,
        timestamp: new Date().toISOString(),
      };

      // Persist assistant message (already masked)
      db.addMessage(message);

      // Send updated session (with new name if auto-named)
      const updatedSession = db.getSession(sessionId);
      if (updatedSession) {
        send(ws, { type: "session_updated", session: updatedSession });
      }

      send(ws, { type: "turn_complete", sessionId, message });

      // If cancel was in progress, signal completion
      if (active.status === "cancelling") {
        send(ws, { type: "cancel_complete", sessionId });
      }

      // Check queue: if messages queued, process next
      if (active.queue.length > 0) {
        const next = active.queue.shift()!;
        debug("ws", `processing queued message session=${sessionId}`, { contentLength: next.content.length, remainingQueue: active.queue.length });
        startAgentTurn(ws, sessionId, next.content, config, db, activeSessions, next.images);
      } else {
        // No more work — clean up
        activeSessions.delete(sessionId);
        // Send idle status
        send(ws, {
          type: "status_update",
          sessionId,
          status: "idle",
          toolName: null,
          startedAt: null,
          queueDepth: 0,
        });
      }
    },

    onError: (error) => {
      debug("ws", `agent error for session=${sessionId}: ${error}`);

      // Clear force-cleanup timeout if set
      if (active.cancelTimeout) {
        clearTimeout(active.cancelTimeout);
        active.cancelTimeout = null;
      }

      // Clear queue on error — don't auto-drain
      if (active.queue.length > 0) {
        active.queue = [];
        send(ws, { type: "queue_cleared", sessionId });
      }

      send(ws, { type: "error", sessionId, message: error });
      activeSessions.delete(sessionId);

      // Send idle status
      send(ws, {
        type: "status_update",
        sessionId,
        status: "idle",
        toolName: null,
        startedAt: null,
        queueDepth: 0,
      });
    },

    onApprovalNeeded: (toolUseId, toolName, input) => {
      debug("ws", `approval needed session=${sessionId} tool=${toolName} toolUseId=${toolUseId}`, input);

      // Check if this tool has been auto-approved for this session
      if (active.autoApprovedTools.has(toolName)) {
        debug("ws", `auto-approved (session-scoped) tool=${toolName} toolUseId=${toolUseId}`);
        return Promise.resolve({ approved: true });
      }

      active.status = "awaiting_approval";
      active.currentToolName = toolName;
      sendStatusUpdate(ws, sessionId, active);

      return new Promise<{ approved: boolean; denyMessage?: string }>((resolve) => {
        pendingApprovals.set(toolUseId, (result) => {
          resolve({ approved: result.approved, denyMessage: result.denyMessage });
        });

        send(ws, {
          type: "approval_request",
          sessionId,
          toolUseId,
          toolName,
          input: maskSecretsInObject(input),
        });

        // 5-minute timeout → auto-deny
        setTimeout(() => {
          if (pendingApprovals.has(toolUseId)) {
            debug("ws", `approval timeout (5min) auto-denying tool=${toolName} toolUseId=${toolUseId}`);
            pendingApprovals.delete(toolUseId);
            resolve({ approved: false });
          }
        }, 5 * 60 * 1000);
      });
    },
  }, images, conversationHistory);
}
