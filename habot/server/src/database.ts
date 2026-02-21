import Database from "better-sqlite3";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatSession, ChatMessage, ToolCallInfo, TokenUsage, ImageAttachment, MessageSegment } from "./types.js";
import { debug } from "./logger.js";

export class SessionDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, "habot.db");
    debug("db", `opening database at ${dbPath}`);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    debug("db", "database initialized and migrated");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        agent_session_id TEXT,
        resume_context TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        token_usage TEXT,
        cost_usd REAL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    `);

    // Add images column if it doesn't exist (migration for existing databases)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN images TEXT`);
      debug("db", "added images column to messages table");
    } catch {
      // Column already exists — ignore
    }

    // Add segments column if it doesn't exist (migration for existing databases)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN segments TEXT`);
      debug("db", "added segments column to messages table");
    } catch {
      // Column already exists — ignore
    }
  }

  // Sessions

  createSession(name?: string): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      name: name ?? "New Chat",
      status: "active",
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, name, status, agent_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(session.id, session.name, session.status, session.agentSessionId, session.createdAt, session.updatedAt);

    debug("db", `session created`, { id: session.id, name: session.name });
    return session;
  }

  getSession(id: string): ChatSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    debug("db", `getSession id=${id} found=${!!row}`);
    return row ? this.rowToSession(row) : null;
  }

  listSessions(): ChatSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status != 'archived' ORDER BY updated_at DESC")
      .all() as SessionRow[];
    debug("db", `listSessions count=${rows.length}`);
    return rows.map((r) => this.rowToSession(r));
  }

  updateSession(id: string, updates: Partial<Pick<ChatSession, "name" | "status" | "agentSessionId">>): ChatSession | null {
    debug("db", `updateSession id=${id}`, updates);
    const session = this.getSession(id);
    if (!session) {
      debug("db", `updateSession id=${id} not found`);
      return null;
    }

    const name = updates.name ?? session.name;
    const status = updates.status ?? session.status;
    const agentSessionId = updates.agentSessionId !== undefined ? updates.agentSessionId : session.agentSessionId;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE sessions SET name = ?, status = ?, agent_session_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(name, status, agentSessionId, now, id);

    debug("db", `updateSession id=${id} status=${session.status}->${status}`);
    return { ...session, name, status, agentSessionId, updatedAt: now };
  }

  setResumeContext(id: string, context: string): void {
    debug("db", `setResumeContext id=${id}`, { context });
    this.db
      .prepare("UPDATE sessions SET resume_context = ?, status = 'awaiting_resume' WHERE id = ?")
      .run(context, id);
    debug("db", `setResumeContext id=${id} status->awaiting_resume`);
  }

  getAwaitingResumeSessions(): Array<ChatSession & { resumeContext: string }> {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = 'awaiting_resume' ORDER BY updated_at ASC")
      .all() as SessionRow[];
    const results = rows
      .filter((r) => r.resume_context)
      .map((r) => ({
        ...this.rowToSession(r),
        resumeContext: r.resume_context!,
      }));
    debug("db", `getAwaitingResumeSessions found=${results.length}`, { ids: results.map((r) => r.id) });
    return results;
  }

  archiveSession(id: string): void {
    debug("db", `archiveSession id=${id}`);
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(now, id);
    debug("db", `archiveSession id=${id} complete`);
  }

  deleteSession(id: string): void {
    debug("db", `deleteSession id=${id}`);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    debug("db", `deleteSession id=${id} complete`);
  }

  // Messages

  addMessage(msg: ChatMessage): void {
    debug("db", `addMessage session=${msg.sessionId} role=${msg.role}`, {
      id: msg.id,
      contentLength: msg.content.length,
      contentPreview: msg.content.substring(0, 100),
      hasToolCalls: !!msg.toolCalls,
      toolCallCount: msg.toolCalls?.length ?? 0,
      costUsd: msg.costUsd,
    });

    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, tool_calls, token_usage, cost_usd, timestamp, images, segments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.sessionId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.tokenUsage ? JSON.stringify(msg.tokenUsage) : null,
        msg.costUsd,
        msg.timestamp,
        msg.images ? JSON.stringify(msg.images) : null,
        msg.segments ? JSON.stringify(msg.segments) : null,
      );

    // Update session timestamp
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(msg.timestamp, msg.sessionId);
  }

  getMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC")
      .all(sessionId) as MessageRow[];
    debug("db", `getMessages session=${sessionId} count=${rows.length}`);
    return rows.map((r) => this.rowToMessage(r));
  }

  // Auto-name session from first user message
  autoNameSession(sessionId: string, firstMessage: string): void {
    const name = firstMessage.length > 50 ? firstMessage.substring(0, 47) + "..." : firstMessage;
    debug("db", `autoNameSession session=${sessionId} name="${name}"`);
    this.db
      .prepare("UPDATE sessions SET name = ? WHERE id = ? AND name = 'New Chat'")
      .run(name, sessionId);
  }

  close(): void {
    debug("db", "closing database");
    this.db.close();
  }

  // Row mappers

  private rowToSession(row: SessionRow): ChatSession {
    return {
      id: row.id,
      name: row.name,
      status: row.status as ChatSession["status"],
      agentSessionId: row.agent_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToMessage(row: MessageRow): ChatMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as ChatMessage["role"],
      content: row.content,
      images: row.images ? (JSON.parse(row.images) as ImageAttachment[]) : null,
      toolCalls: row.tool_calls ? (JSON.parse(row.tool_calls) as ToolCallInfo[]) : null,
      segments: row.segments ? (JSON.parse(row.segments) as MessageSegment[]) : null,
      tokenUsage: row.token_usage ? (JSON.parse(row.token_usage) as TokenUsage) : null,
      costUsd: row.cost_usd,
      timestamp: row.timestamp,
    };
  }
}

interface SessionRow {
  id: string;
  name: string;
  status: string;
  agent_session_id: string | null;
  resume_context: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  segments: string | null;
  token_usage: string | null;
  cost_usd: number | null;
  timestamp: string;
  images: string | null;
}
