import type { ChatSession } from "../types";

interface SidebarProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onArchive: (id: string) => void;
  connected: boolean;
  isOpen: boolean;
  onToggle: () => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onArchive,
  connected,
  isOpen,
  onToggle,
}: SidebarProps) {
  return (
    <div className={`sidebar${isOpen ? " open" : " closed"}`}>
      <div className="sidebar-header">
        <h2>HABot</h2>
        <div className={`status-dot ${connected ? "connected" : "disconnected"}`} />
        <button className="sidebar-close-btn" onClick={onToggle} title="Close sidebar">
          &times;
        </button>
      </div>

      <button className="new-chat-btn" onClick={onNewChat}>
        + New Chat
      </button>

      <div className="session-list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`session-item ${session.id === activeSessionId ? "active" : ""}`}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="session-name">{session.name}</span>
            <span className="session-date">
              {new Date(session.updatedAt).toLocaleDateString()}
            </span>
            <button
              className="session-archive-btn"
              title="Archive chat"
              onClick={(e) => {
                e.stopPropagation();
                onArchive(session.id);
              }}
            >
              &times;
            </button>
          </div>
        ))}

        {sessions.length === 0 && (
          <p className="no-sessions">No conversations yet. Start a new chat!</p>
        )}
      </div>
    </div>
  );
}
