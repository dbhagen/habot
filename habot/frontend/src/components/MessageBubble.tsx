import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";
import { ToolCallDisplay } from "./ToolCallDisplay";

/** Highlight @entity_id references in user messages */
function highlightEntities(text: string): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  const regex = /@([a-z_]+\.[a-z0-9_]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <span key={match.index} className="entity-mention">
        @{match[1]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  // Use segments for interleaved rendering when available (assistant messages with tool calls)
  const hasSegments = message.segments && message.segments.length > 0 && message.toolCalls;

  return (
    <div className={`message message-${message.role}`}>
      <div className="message-header">
        <span className="message-role">
          {message.role === "user" ? "You" : message.role === "assistant" ? "Claude" : "System"}
        </span>
        <span className="message-time">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {message.images && message.images.length > 0 && (
        <div className="message-images">
          {message.images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              className="message-image"
              alt={`Attachment ${i + 1}`}
            />
          ))}
        </div>
      )}

      {hasSegments ? (
        /* Interleaved rendering: text and tool calls in original order */
        <>
          {message.segments!.map((segment, i) => {
            if (segment.type === "text") {
              return (
                <div key={`seg-text-${i}`} className="message-content">
                  <Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown>
                </div>
              );
            }
            // Tool segment — find matching tool call
            const tc = message.toolCalls!.find((t) => t.id === segment.toolCallId);
            if (tc) {
              return <ToolCallDisplay key={tc.id} toolCall={tc} />;
            }
            return null;
          })}
        </>
      ) : (
        /* Fallback rendering for legacy messages without segments */
        <>
          {message.content && (
            <div className="message-content">
              {message.role === "user" ? (
                <p>{highlightEntities(message.content)}</p>
              ) : (
                <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
              )}
            </div>
          )}

          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="message-tool-calls">
              <div className="tool-calls-label">{message.toolCalls.length} tool call{message.toolCalls.length > 1 ? "s" : ""}</div>
              {message.toolCalls.map((tc) => (
                <ToolCallDisplay key={tc.id} toolCall={tc} />
              ))}
            </div>
          )}
        </>
      )}

      {message.costUsd != null && (
        <div className="message-cost">
          ${message.costUsd.toFixed(4)}
        </div>
      )}
    </div>
  );
}
