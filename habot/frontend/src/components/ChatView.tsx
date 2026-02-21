import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolCallInfo, AgentStatus, ImageAttachment } from "../types";
import type { StreamSegment } from "../hooks/useWebSocket";
import { MessageBubble } from "./MessageBubble";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { ChatInput } from "./ChatInput";

function StatusIndicator({
  status,
  toolName,
  startedAt,
}: {
  status: AgentStatus;
  toolName: string | null;
  startedAt: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    const start = new Date(startedAt).getTime();
    setElapsed(Math.floor((Date.now() - start) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  let label: string;
  switch (status) {
    case "thinking":
      label = "thinking...";
      break;
    case "responding":
      label = "responding...";
      break;
    case "tool_use": {
      const short = toolName?.replace("mcp__ha-mcp__", "") ?? "tool";
      label = `using ${short}...`;
      break;
    }
    case "awaiting_approval":
      label = "waiting for approval";
      break;
    case "cancelling":
      label = "cancelling...";
      break;
    default:
      label = "thinking...";
  }

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="status-indicator-bar">
      <span className="streaming-indicator">{label}</span>
      {startedAt && elapsed > 0 && (
        <span className="elapsed-time">{formatElapsed(elapsed)}</span>
      )}
    </div>
  );
}

interface ChatViewProps {
  messages: ChatMessage[];
  streamingText: string;
  streamingToolCalls: ToolCallInfo[];
  streamSegments: StreamSegment[];
  isStreaming: boolean;
  approvalRequest: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
  } | null;
  agentStatus: AgentStatus;
  currentToolName: string | null;
  agentStartedAt: string | null;
  queueDepth: number;
  isCancelling: boolean;
  onSendMessage: (content: string, images?: ImageAttachment[]) => void;
  onCancel: () => void;
  onApprove: (toolUseId: string, autoApprove?: boolean) => void;
  onDeny: (toolUseId: string, denyMessage?: string) => void;
  hasSession: boolean;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}

export function ChatView({
  messages,
  streamingToolCalls,
  streamSegments,
  isStreaming,
  approvalRequest,
  agentStatus,
  currentToolName,
  agentStartedAt,
  queueDepth,
  isCancelling,
  onSendMessage,
  onCancel,
  onApprove,
  onDeny,
  hasSession,
  onToggleSidebar,
  sidebarOpen,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamSegments, streamingToolCalls]);

  // Check if there's any streaming content to show
  const hasStreamingContent = streamSegments.length > 0;

  return (
    <div className="chat-view">
      {!sidebarOpen && (
        <button className="sidebar-toggle-btn" onClick={onToggleSidebar} title="Open sidebar">
          <span className="hamburger-icon" />
        </button>
      )}
      <div className="messages-container" ref={scrollRef}>
        {messages.length === 0 && !isStreaming && (
          <div className="empty-state">
            <h2>HABot</h2>
            <p>Ask HABot about your Home Assistant setup.</p>
            <div className="example-prompts">
              <button onClick={() => onSendMessage("What entities are in my living room?")}>
                What entities are in my living room?
              </button>
              <button onClick={() => onSendMessage("Show me my automations")}>
                Show me my automations
              </button>
              <button onClick={() => onSendMessage("Are there any updates available?")}>
                Are there any updates available?
              </button>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming assistant response — interleaved segments */}
        {isStreaming && (hasStreamingContent || agentStatus === "thinking") && (
          <div className="message message-assistant streaming">
            <div className="message-header">
              <span className="message-role">Claude</span>
            </div>

            {streamSegments.map((segment, i) => {
              if (segment.type === "text") {
                return (
                  <div key={`seg-text-${i}`} className="message-content">
                    <Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown>
                  </div>
                );
              }
              // Tool segment — look up the tool call
              const tc = streamingToolCalls.find((t) => t.id === segment.toolCallId);
              if (tc) {
                return <ToolCallDisplay key={tc.id} toolCall={tc} />;
              }
              return null;
            })}

            {/* Status indicator at bottom */}
            <StatusIndicator
              status={agentStatus}
              toolName={currentToolName}
              startedAt={agentStartedAt}
            />
          </div>
        )}

        {/* Approval prompt */}
        {approvalRequest && (
          <ApprovalPrompt
            toolName={approvalRequest.toolName}
            input={approvalRequest.input}
            onApprove={() => onApprove(approvalRequest.toolUseId)}
            onApproveAlways={() => onApprove(approvalRequest.toolUseId, true)}
            onDeny={() => onDeny(approvalRequest.toolUseId)}
            onDenyWithMessage={(message) => onDeny(approvalRequest.toolUseId, message)}
          />
        )}

        {/* Queue indicator */}
        {isStreaming && queueDepth > 0 && (
          <div className="queue-indicator">
            {queueDepth} message{queueDepth > 1 ? "s" : ""} queued
          </div>
        )}
      </div>

      <ChatInput
        onSend={onSendMessage}
        onCancel={onCancel}
        isStreaming={isStreaming}
        isCancelling={isCancelling}
        queueDepth={queueDepth}
        disabled={false}
      />
    </div>
  );
}
