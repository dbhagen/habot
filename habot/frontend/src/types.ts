export interface ChatSession {
  id: string;
  name: string;
  status: "active" | "idle" | "awaiting_resume" | "archived";
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageAttachment {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64-encoded, no data: URI prefix
}

export type MessageSegment =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string };

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  images: ImageAttachment[] | null;
  toolCalls: ToolCallInfo[] | null;
  segments: MessageSegment[] | null;
  tokenUsage: TokenUsage | null;
  costUsd: number | null;
  timestamp: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  status: "pending" | "running" | "complete" | "error";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// Agent lifecycle status
export type AgentStatus = "idle" | "thinking" | "responding" | "tool_use" | "awaiting_approval" | "cancelling";

// Server → client messages
export type ServerMessage =
  | { type: "server_hello"; startupId: string }
  | { type: "stream_text"; sessionId: string; text: string }
  | { type: "stream_tool_use"; sessionId: string; toolCall: ToolCallInfo }
  | { type: "turn_complete"; sessionId: string; message: ChatMessage }
  | { type: "approval_request"; sessionId: string; toolUseId: string; toolName: string; input: unknown }
  | { type: "error"; sessionId: string | null; message: string }
  | { type: "sessions_list"; sessions: ChatSession[] }
  | { type: "messages_list"; sessionId: string; messages: ChatMessage[] }
  | { type: "session_created"; session: ChatSession }
  | { type: "session_updated"; session: ChatSession }
  | { type: "session_deleted"; sessionId: string }
  | { type: "status_update"; sessionId: string; status: AgentStatus; toolName: string | null; startedAt: string | null; queueDepth: number }
  | { type: "message_queued"; sessionId: string; messageId: string; position: number }
  | { type: "queue_cleared"; sessionId: string }
  | { type: "cancel_complete"; sessionId: string };
