import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSession, ServerMessage, ToolCallInfo, AgentStatus, ImageAttachment } from "../types";
import { getWebSocketUrl } from "../utils/ingress";
import { debug } from "../utils/debug";

// crypto.randomUUID() requires a secure context (HTTPS); use Math.random fallback for HTTP (HA Ingress)
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

type ApprovalRequest = {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
};

export type StreamSegment =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string };

interface SessionStreamingState {
  text: string;
  toolCalls: ToolCallInfo[];
  segments: StreamSegment[];
  isStreaming: boolean;
  approvalRequest: ApprovalRequest | null;
  status: AgentStatus;
  currentToolName: string | null;
  startedAt: string | null;
  queueDepth: number;
  isCancelling: boolean;
}

function emptyStreamingState(): SessionStreamingState {
  return {
    text: "",
    toolCalls: [],
    segments: [],
    isStreaming: false,
    approvalRequest: null,
    status: "idle",
    currentToolName: null,
    startedAt: null,
    queueDepth: 0,
    isCancelling: false,
  };
}

export interface UseWebSocketReturn {
  connected: boolean;
  sessions: ChatSession[];
  messages: ChatMessage[];
  streamingText: string;
  streamingToolCalls: ToolCallInfo[];
  streamSegments: StreamSegment[];
  isStreaming: boolean;
  approvalRequest: ApprovalRequest | null;
  agentStatus: AgentStatus;
  currentToolName: string | null;
  agentStartedAt: string | null;
  queueDepth: number;
  isCancelling: boolean;
  sendMessage: (sessionId: string, content: string, images?: ImageAttachment[]) => void;
  cancelGeneration: (sessionId: string) => void;
  approveTool: (sessionId: string, toolUseId: string, approved: boolean, options?: { autoApprove?: boolean; denyMessage?: string }) => void;
  createSession: () => void;
  loadSessions: () => void;
  loadMessages: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
}

export function useWebSocket(activeSessionId: string | null): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Per-session streaming state, keyed by sessionId
  const streamingBySession = useRef<Map<string, SessionStreamingState>>(new Map());
  const activeSessionRef = useRef<string | null>(activeSessionId);

  // Track server startup ID to detect add-on restarts
  const serverStartupIdRef = useRef<string | null>(null);

  // React state for the currently-viewed session's streaming
  const [streamingText, setStreamingText] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallInfo[]>([]);
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const [currentToolName, setCurrentToolName] = useState<string | null>(null);
  const [agentStartedAt, setAgentStartedAt] = useState<string | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);

  // Keep ref in sync and restore streaming state when active session changes
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
    const state = activeSessionId ? streamingBySession.current.get(activeSessionId) : undefined;
    if (state) {
      debug("ws", `restoring streaming state for session=${activeSessionId}`, {
        textLength: state.text.length,
        toolCallCount: state.toolCalls.length,
        isStreaming: state.isStreaming,
        status: state.status,
        queueDepth: state.queueDepth,
      });
      setStreamingText(state.text);
      setStreamingToolCalls(state.toolCalls);
      setStreamSegments(state.segments);
      setIsStreaming(state.isStreaming);
      setApprovalRequest(state.approvalRequest);
      setAgentStatus(state.status);
      setCurrentToolName(state.currentToolName);
      setAgentStartedAt(state.startedAt);
      setQueueDepth(state.queueDepth);
      setIsCancelling(state.isCancelling);
    } else {
      setStreamingText("");
      setStreamingToolCalls([]);
      setStreamSegments([]);
      setIsStreaming(false);
      setApprovalRequest(null);
      setAgentStatus("idle");
      setCurrentToolName(null);
      setAgentStartedAt(null);
      setQueueDepth(0);
      setIsCancelling(false);
    }
  }, [activeSessionId]);

  // Helper: get or create the streaming entry for a session
  function getEntry(sid: string): SessionStreamingState {
    let entry = streamingBySession.current.get(sid);
    if (!entry) {
      entry = emptyStreamingState();
      streamingBySession.current.set(sid, entry);
    }
    return entry;
  }

  // Helper: if sid is the active session, sync React state from the ref entry
  function syncIfActive(sid: string, entry: SessionStreamingState) {
    if (sid === activeSessionRef.current) {
      setStreamingText(entry.text);
      setStreamingToolCalls(entry.toolCalls);
      setStreamSegments([...entry.segments]);
      setIsStreaming(entry.isStreaming);
      setApprovalRequest(entry.approvalRequest);
      setAgentStatus(entry.status);
      setCurrentToolName(entry.currentToolName);
      setAgentStartedAt(entry.startedAt);
      setQueueDepth(entry.queueDepth);
      setIsCancelling(entry.isCancelling);
    }
  }

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "server_hello": {
        debug("ws", `server hello startupId=${msg.startupId}`);
        if (serverStartupIdRef.current === null) {
          // First connection — store the startup ID
          serverStartupIdRef.current = msg.startupId;
        } else if (serverStartupIdRef.current !== msg.startupId) {
          // Server restarted (add-on rebuild/restart) — reload to pick up new assets
          debug("ws", `server restarted (old=${serverStartupIdRef.current} new=${msg.startupId}), reloading page`);
          window.location.reload();
        }
        break;
      }

      case "stream_text": {
        const entry = getEntry(msg.sessionId);
        entry.text += msg.text;
        // Append to last text segment or create a new one
        const lastSeg = entry.segments[entry.segments.length - 1];
        if (lastSeg && lastSeg.type === "text") {
          lastSeg.text += msg.text;
        } else {
          entry.segments.push({ type: "text", text: msg.text });
        }
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "stream_tool_use": {
        debug("tools", `tool update: ${msg.toolCall.name} status=${msg.toolCall.status}`);
        const entry = getEntry(msg.sessionId);
        const existing = entry.toolCalls.findIndex((t) => t.id === msg.toolCall.id);
        if (existing >= 0) {
          entry.toolCalls = [...entry.toolCalls];
          entry.toolCalls[existing] = msg.toolCall;
        } else {
          entry.toolCalls = [...entry.toolCalls, msg.toolCall];
          // Add a tool segment for new tool calls (not updates)
          entry.segments.push({ type: "tool", toolCallId: msg.toolCall.id });
        }
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "turn_complete": {
        debug("messages", `turn complete session=${msg.sessionId}`, {
          contentLength: msg.message.content.length,
          role: msg.message.role,
          hasToolCalls: !!msg.message.toolCalls,
          costUsd: msg.message.costUsd,
        });
        // Reset streaming text/tools for this turn (queue may start a new turn)
        const entry = streamingBySession.current.get(msg.sessionId);
        if (entry) {
          entry.text = "";
          entry.toolCalls = [];
          entry.segments = [];
          entry.approvalRequest = null;
        }
        setMessages((prev) => [...prev, msg.message]);
        if (msg.sessionId === activeSessionRef.current) {
          setStreamingText("");
          setStreamingToolCalls([]);
          setStreamSegments([]);
          setApprovalRequest(null);
        }
        break;
      }

      case "status_update": {
        debug("ws", `status update session=${msg.sessionId} status=${msg.status} tool=${msg.toolName} queue=${msg.queueDepth}`);
        const entry = getEntry(msg.sessionId);
        entry.status = msg.status;
        entry.currentToolName = msg.toolName;
        entry.startedAt = msg.startedAt;
        entry.queueDepth = msg.queueDepth;

        if (msg.status === "idle") {
          entry.isStreaming = false;
          entry.isCancelling = false;
          streamingBySession.current.delete(msg.sessionId);
        } else {
          entry.isStreaming = true;
          if (msg.status === "cancelling") {
            entry.isCancelling = true;
          }
        }
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "message_queued": {
        debug("ws", `message queued session=${msg.sessionId} position=${msg.position}`);
        const entry = getEntry(msg.sessionId);
        entry.queueDepth = msg.position;
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "queue_cleared": {
        debug("ws", `queue cleared session=${msg.sessionId}`);
        const entry = getEntry(msg.sessionId);
        entry.queueDepth = 0;
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "cancel_complete": {
        debug("ws", `cancel complete session=${msg.sessionId}`);
        const entry = streamingBySession.current.get(msg.sessionId);
        if (entry) {
          entry.isCancelling = false;
          entry.isStreaming = false;
          syncIfActive(msg.sessionId, entry);
        }
        break;
      }

      case "approval_request": {
        debug("tools", `approval request tool=${msg.toolName} toolUseId=${msg.toolUseId}`, msg.input);
        const entry = getEntry(msg.sessionId);
        entry.approvalRequest = {
          sessionId: msg.sessionId,
          toolUseId: msg.toolUseId,
          toolName: msg.toolName,
          input: msg.input,
        };
        syncIfActive(msg.sessionId, entry);
        break;
      }

      case "error": {
        debug("ws", `server error: ${msg.message}`, { sessionId: msg.sessionId });
        if (msg.sessionId) {
          const entry = streamingBySession.current.get(msg.sessionId);
          if (entry) {
            entry.isStreaming = false;
            entry.isCancelling = false;
            entry.status = "idle";
            syncIfActive(msg.sessionId, entry);
          }
          setMessages((prev) => [
            ...prev,
            {
              id: generateId(),
              sessionId: msg.sessionId!,
              role: "system",
              content: `Error: ${msg.message}`,
              images: null,
              toolCalls: null,
              segments: null,
              tokenUsage: null,
              costUsd: null,
              timestamp: new Date().toISOString(),
            },
          ]);
        } else {
          // Non-session error — clear active streaming just in case
          setIsStreaming(false);
        }
        break;
      }

      case "sessions_list":
        debug("session", `sessions loaded count=${msg.sessions.length}`);
        setSessions(msg.sessions);
        break;

      case "messages_list":
        debug("messages", `messages loaded session=${msg.sessionId} count=${msg.messages.length}`);
        setMessages(msg.messages);
        break;

      case "session_created":
        debug("session", `session created id=${msg.session.id} name="${msg.session.name}"`);
        setSessions((prev) => [...prev, msg.session]);
        break;

      case "session_updated":
        debug("session", `session updated id=${msg.session.id}`, {
          name: msg.session.name,
          status: msg.session.status,
        });
        setSessions((prev) =>
          prev.map((s) => (s.id === msg.session.id ? msg.session : s)),
        );
        break;

      case "session_deleted":
        debug("session", `session deleted id=${msg.sessionId}`);
        setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
        streamingBySession.current.delete(msg.sessionId);
        break;
    }
  }, []);

  const connect = useCallback(() => {
    const url = getWebSocketUrl();
    debug("ws", `connecting to ${url}`);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      debug("ws", "connection opened");
      setConnected(true);
    };

    ws.onclose = () => {
      debug("ws", "connection closed, reconnecting in 2s");
      setConnected(false);
      // Reconnect after 2 seconds
      setTimeout(connect, 2000);
    };

    ws.onerror = (e) => {
      debug("ws", "connection error", e);
    };

    ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      debug("ws", `received type=${msg.type}${"sessionId" in msg ? ` session=${(msg as { sessionId: string }).sessionId}` : ""}`);
      handleServerMessage(msg);
    };
  }, [handleServerMessage]);

  useEffect(() => {
    connect();
    return () => {
      debug("ws", "component unmounting, closing WebSocket");
      wsRef.current?.close();
    };
  }, [connect]);

  const sendJSON = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const typed = data as { type: string };
      debug("ws", `sending type=${typed.type}`, data);
      wsRef.current.send(JSON.stringify(data));
    } else {
      debug("ws", "cannot send, WebSocket not open", data);
    }
  }, []);

  const sendMessage = useCallback(
    (sessionId: string, content: string, images?: ImageAttachment[]) => {
      debug("messages", `sending message session=${sessionId}`, {
        contentLength: content.length,
        contentPreview: content.substring(0, 100),
        imageCount: images?.length ?? 0,
      });
      const messageImages = images && images.length > 0 ? images : null;
      // Add user message to local state immediately
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          sessionId,
          role: "user" as const,
          content,
          images: messageImages,
          toolCalls: null,
          segments: null,
          tokenUsage: null,
          costUsd: null,
          timestamp: new Date().toISOString(),
        },
      ]);
      // Initialize streaming state for this session (if not already streaming)
      const entry = getEntry(sessionId);
      if (!entry.isStreaming) {
        entry.isStreaming = true;
        entry.status = "thinking";
        entry.startedAt = new Date().toISOString();
        entry.text = "";
        entry.toolCalls = [];
        entry.segments = [];
      }
      syncIfActive(sessionId, entry);
      sendJSON({ type: "send_message", sessionId, content, ...(messageImages ? { images: messageImages } : {}) });
    },
    [sendJSON],
  );

  const cancelGeneration = useCallback(
    (sessionId: string) => {
      debug("ws", `cancelling generation session=${sessionId}`);
      // Optimistic update
      const entry = streamingBySession.current.get(sessionId);
      if (entry) {
        entry.isCancelling = true;
        entry.status = "cancelling";
        syncIfActive(sessionId, entry);
      }
      sendJSON({ type: "cancel", sessionId });
    },
    [sendJSON],
  );

  const approveTool = useCallback(
    (sessionId: string, toolUseId: string, approved: boolean, options?: { autoApprove?: boolean; denyMessage?: string }) => {
      debug("tools", `tool ${approved ? "approved" : "denied"} session=${sessionId} toolUseId=${toolUseId}`, { autoApprove: options?.autoApprove, denyMessage: options?.denyMessage });
      sendJSON({
        type: "approve_tool",
        sessionId,
        toolUseId,
        approved,
        ...(options?.autoApprove ? { autoApprove: true } : {}),
        ...(options?.denyMessage ? { denyMessage: options.denyMessage } : {}),
      });
      const entry = streamingBySession.current.get(sessionId);
      if (entry) {
        entry.approvalRequest = null;
        syncIfActive(sessionId, entry);
      }
    },
    [sendJSON],
  );

  const createSession = useCallback(() => {
    debug("session", "creating new session");
    sendJSON({ type: "create_session" });
  }, [sendJSON]);

  const loadSessions = useCallback(() => {
    debug("session", "loading sessions");
    sendJSON({ type: "list_sessions" });
  }, [sendJSON]);

  const loadMessages = useCallback(
    (sessionId: string) => {
      debug("messages", `loading messages for session=${sessionId}`);
      sendJSON({ type: "get_messages", sessionId });
    },
    [sendJSON],
  );

  const archiveSession = useCallback(
    (sessionId: string) => {
      debug("session", `archiving session=${sessionId}`);
      sendJSON({ type: "archive_session", sessionId });
    },
    [sendJSON],
  );

  return {
    connected,
    sessions,
    messages,
    streamingText,
    streamingToolCalls,
    streamSegments,
    isStreaming,
    approvalRequest,
    agentStatus,
    currentToolName,
    agentStartedAt,
    queueDepth,
    isCancelling,
    sendMessage,
    cancelGeneration,
    approveTool,
    createSession,
    loadSessions,
    loadMessages,
    archiveSession,
  };
}
