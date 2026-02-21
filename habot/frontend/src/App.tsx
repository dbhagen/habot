import { useState, useCallback, useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { useWebSocket } from "./hooks/useWebSocket";
import type { ImageAttachment } from "./types";
import { initDebugLogging, debug } from "./utils/debug";
import "./styles.css";

// Initialize debug logging from server config
initDebugLogging();

const STORAGE_KEY = "habot-active-session";
const SIDEBAR_KEY = "habot-sidebar-open";

function getSavedSession(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSession(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable in some iframe contexts
  }
}

function getInitialSidebarState(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved !== null) return saved === "true";
  } catch {
    // ignore
  }
  // Default: open on desktop, closed on mobile
  return window.innerWidth > 768;
}

function saveSidebarState(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(open));
  } catch {
    // ignore
  }
}

export function App() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(getSavedSession);
  const ws = useWebSocket(activeSessionId);

  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarState);

  // Pending message to send after session creation
  const pendingMessageRef = useRef<{ content: string; images?: ImageAttachment[] } | null>(null);

  // Load sessions on connect
  useEffect(() => {
    if (ws.connected) {
      debug("ui", "connected, loading sessions");
      ws.loadSessions();
    }
  }, [ws.connected]);

  const handleNewChat = useCallback(() => {
    debug("ui", "new chat requested");
    ws.createSession();
  }, [ws]);

  // When sessions first load, restore saved session or auto-select latest
  useEffect(() => {
    if (ws.sessions.length === 0 || initialLoadDone) return;
    setInitialLoadDone(true);

    const savedId = getSavedSession();
    const validSaved = savedId && ws.sessions.some((s) => s.id === savedId);
    const targetId = validSaved ? savedId : ws.sessions[ws.sessions.length - 1].id;
    debug("session", `initial session id=${targetId} fromSaved=${!!validSaved}`);
    setActiveSessionId(targetId);
    saveSession(targetId);
    ws.loadMessages(targetId);
  }, [ws.sessions, initialLoadDone]);

  // When a new session is created, auto-select it and send any pending message
  const prevSessionCountRef = useRef(ws.sessions.length);
  useEffect(() => {
    const prevCount = prevSessionCountRef.current;
    prevSessionCountRef.current = ws.sessions.length;

    // Detect newly added session (count went up)
    if (ws.sessions.length > prevCount && ws.sessions.length > 0) {
      const newest = ws.sessions[ws.sessions.length - 1];
      debug("session", `new session detected id=${newest.id}, auto-selecting`);
      setActiveSessionId(newest.id);
      saveSession(newest.id);
      ws.loadMessages(newest.id);

      // Send pending message if any
      if (pendingMessageRef.current) {
        const { content, images } = pendingMessageRef.current;
        pendingMessageRef.current = null;
        debug("ui", `sending pending message to new session=${newest.id}`, {
          contentLength: content.length,
        });
        // Small delay to ensure state has settled
        setTimeout(() => {
          ws.sendMessage(newest.id, content, images);
        }, 50);
      }
    }
  }, [ws.sessions]);

  const handleSelectSession = useCallback(
    (id: string) => {
      debug("session", `session selected id=${id}`, { previousId: activeSessionId });
      setActiveSessionId(id);
      saveSession(id);
      ws.loadMessages(id);
      // Auto-close sidebar on mobile
      if (window.innerWidth <= 768) {
        setSidebarOpen(false);
        saveSidebarState(false);
      }
    },
    [ws],
  );

  const handleSendMessage = useCallback(
    (content: string, images?: ImageAttachment[]) => {
      if (!activeSessionId) {
        debug("ui", "no active session, creating one and queuing message");
        pendingMessageRef.current = { content, images };
        ws.createSession();
        return;
      }
      debug("ui", `submitting message session=${activeSessionId}`, {
        contentLength: content.length,
        contentPreview: content.substring(0, 80),
        imageCount: images?.length ?? 0,
      });
      ws.sendMessage(activeSessionId, content, images);
    },
    [activeSessionId, ws],
  );

  const handleCancel = useCallback(() => {
    if (activeSessionId) {
      debug("ui", `cancel requested session=${activeSessionId}`);
      ws.cancelGeneration(activeSessionId);
    }
  }, [activeSessionId, ws]);

  const handleApprove = useCallback(
    (toolUseId: string, autoApprove?: boolean) => {
      if (activeSessionId) {
        debug("tools", `user approved tool toolUseId=${toolUseId} session=${activeSessionId} autoApprove=${autoApprove ?? false}`);
        ws.approveTool(activeSessionId, toolUseId, true, autoApprove ? { autoApprove: true } : undefined);
      }
    },
    [activeSessionId, ws],
  );

  const handleArchive = useCallback(
    (id: string) => {
      debug("session", `archiving session id=${id}`);
      ws.archiveSession(id);
      if (activeSessionId === id) {
        const remaining = ws.sessions.filter((s) => s.id !== id);
        const nextId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        debug("session", `archived active session, switching to id=${nextId}`);
        setActiveSessionId(nextId);
        saveSession(nextId);
        if (nextId) {
          ws.loadMessages(nextId);
        }
      }
    },
    [activeSessionId, ws],
  );

  const handleDeny = useCallback(
    (toolUseId: string, denyMessage?: string) => {
      if (activeSessionId) {
        debug("tools", `user denied tool toolUseId=${toolUseId} session=${activeSessionId}`, { denyMessage });
        ws.approveTool(activeSessionId, toolUseId, false, denyMessage ? { denyMessage } : undefined);
      }
    },
    [activeSessionId, ws],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      saveSidebarState(next);
      debug("ui", `sidebar toggled open=${next}`);
      return next;
    });
  }, []);

  // Filter messages for active session
  const sessionMessages = ws.messages.filter(
    (m) => m.sessionId === activeSessionId,
  );

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}>
      {/* Overlay for mobile when sidebar is open */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={toggleSidebar} />
      )}
      <Sidebar
        sessions={ws.sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onArchive={handleArchive}
        connected={ws.connected}
        isOpen={sidebarOpen}
        onToggle={toggleSidebar}
      />
      <ChatView
        messages={sessionMessages}
        streamingText={ws.streamingText}
        streamingToolCalls={ws.streamingToolCalls}
        streamSegments={ws.streamSegments}
        isStreaming={ws.isStreaming}
        approvalRequest={ws.approvalRequest}
        agentStatus={ws.agentStatus}
        currentToolName={ws.currentToolName}
        agentStartedAt={ws.agentStartedAt}
        queueDepth={ws.queueDepth}
        isCancelling={ws.isCancelling}
        onSendMessage={handleSendMessage}
        onCancel={handleCancel}
        onApprove={handleApprove}
        onDeny={handleDeny}
        hasSession={activeSessionId !== null}
        onToggleSidebar={toggleSidebar}
        sidebarOpen={sidebarOpen}
      />
    </div>
  );
}
