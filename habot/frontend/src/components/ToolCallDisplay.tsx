import { useState } from "react";
import type { ToolCallInfo } from "../types";
import { ToolInputDisplay } from "./ToolInputDisplay";

interface ToolCallDisplayProps {
  toolCall: ToolCallInfo;
}

export function ToolCallDisplay({ toolCall }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  // Strip the "mcp__ha-mcp__" prefix for display
  const displayName = toolCall.name.replace(/^mcp__ha-mcp__/, "");

  const statusIcon =
    toolCall.status === "running"
      ? "\u23F3"
      : toolCall.status === "complete"
        ? "\u2713"
        : toolCall.status === "error"
          ? "\u2717"
          : "\u25CB";

  const statusClass = `tool-status-${toolCall.status}`;

  return (
    <div className={`tool-call ${statusClass}`}>
      <button
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-call-icon">{statusIcon}</span>
        <span className="tool-call-name">{displayName}</span>
        <span className="tool-call-toggle">{expanded ? "\u25BE" : "\u25B8"}</span>
      </button>

      {expanded && (
        <div className="tool-call-details">
          <div className="tool-call-section">
            <strong>Input:</strong>
            <ToolInputDisplay toolName={toolCall.name} input={toolCall.input} />
          </div>
          {toolCall.output != null && (
            <div className="tool-call-section">
              <strong>Output:</strong>
              <FormattedOutput output={toolCall.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Render tool output with syntax highlighting for JSON content */
function FormattedOutput({ output }: { output: unknown }) {
  const text = extractText(output);
  // Try to detect if the text content is JSON
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 2) {
    try {
      const parsed = JSON.parse(trimmed);
      return (
        <pre className="tool-output-json">
          <JsonHighlight value={parsed} />
        </pre>
      );
    } catch {
      // Not valid JSON, render as plain text
    }
  }
  return <pre className="tool-output-text">{text}</pre>;
}

/** Extract plain text from SDK output blocks */
function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((block: { type?: string; text?: string }) => {
        if (block.type === "text" && block.text) return block.text;
        return JSON.stringify(block, null, 2);
      })
      .join("\n");
  }
  return JSON.stringify(output, null, 2);
}

/** Recursively render JSON with syntax-highlighted tokens */
function JsonHighlight({ value, indent = 0 }: { value: unknown; indent?: number }) {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);

  if (value === null) {
    return <span className="json-null">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-boolean">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  if (typeof value === "string") {
    // Truncate very long strings for display
    const display = value.length > 500 ? value.slice(0, 500) + "\u2026" : value;
    return <span className="json-string">{`"${escapeJsonString(display)}"`}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="json-bracket">{"[]"}</span>;
    }
    return (
      <>
        <span className="json-bracket">{"["}</span>{"\n"}
        {value.map((item, i) => (
          <span key={i}>
            {padInner}
            <JsonHighlight value={item} indent={indent + 1} />
            {i < value.length - 1 ? <span className="json-punctuation">,</span> : null}{"\n"}
          </span>
        ))}
        {pad}<span className="json-bracket">{"]"}</span>
      </>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="json-bracket">{"{}"}</span>;
    }
    return (
      <>
        <span className="json-bracket">{"{"}</span>{"\n"}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {padInner}
            <span className="json-key">{`"${escapeJsonString(key)}"`}</span>
            <span className="json-punctuation">: </span>
            <JsonHighlight value={val} indent={indent + 1} />
            {i < entries.length - 1 ? <span className="json-punctuation">,</span> : null}{"\n"}
          </span>
        ))}
        {pad}<span className="json-bracket">{"}"}</span>
      </>
    );
  }
  return <span>{String(value)}</span>;
}

function escapeJsonString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
