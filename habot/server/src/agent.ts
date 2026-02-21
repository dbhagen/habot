import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import type { ToolCallInfo, TokenUsage, ImageAttachment, ChatMessage } from "./types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { debug } from "./logger.js";

export interface AgentCallbacks {
  onStreamText: (text: string) => void;
  onToolUse: (toolCall: ToolCallInfo) => void;
  onComplete: (result: {
    text: string;
    toolCalls: ToolCallInfo[];
    sessionId: string;
    usage: TokenUsage | null;
    costUsd: number | null;
  }) => void;
  onError: (error: string) => void;
  onApprovalNeeded: (toolUseId: string, toolName: string, input: unknown) => Promise<{ approved: boolean; denyMessage?: string }>;
  onRestartDetected?: (toolName: string) => void;
}

const RESTART_TOOLS = [
  "mcp__ha-mcp__ha_restart",
  "mcp__ha-mcp__ha_reload_core",
  "mcp__ha-mcp__ha_backup_restore",
];

// Tools that are safe to auto-approve (read-only operations)
const READ_ONLY_TOOLS = [
  // ha-mcp read-only tools
  "mcp__ha-mcp__ha_search_entities",
  "mcp__ha-mcp__ha_get_entity",
  "mcp__ha-mcp__ha_get_entity_state",
  "mcp__ha-mcp__ha_get_history",
  "mcp__ha-mcp__ha_config_list_automations",
  "mcp__ha-mcp__ha_config_get_automation",
  "mcp__ha-mcp__ha_get_automation_traces",
  "mcp__ha-mcp__ha_config_list_dashboards",
  "mcp__ha-mcp__ha_config_get_dashboard",
  "mcp__ha-mcp__ha_get_card_types",
  "mcp__ha-mcp__ha_check_config",
  "mcp__ha-mcp__ha_get_system_info",
  "mcp__ha-mcp__ha_get_updates",
  "mcp__ha-mcp__ha_backup_create",
  "mcp__ha-mcp__ha_get_areas",
  "mcp__ha-mcp__ha_get_floors",
  "mcp__ha-mcp__ha_get_zones",
  "mcp__ha-mcp__ha_get_labels",
  "mcp__ha-mcp__ha_search_config",
  "mcp__ha-mcp__ha_get_overview",
  // Built-in filesystem read-only tools
  "Read",
  "Glob",
  "Grep",
  // Built-in web tools (read-only)
  "WebFetch",
  "WebSearch",
];

// Tools that require explicit user approval (destructive operations)
const DESTRUCTIVE_TOOLS = [
  // ha-mcp destructive tools
  "mcp__ha-mcp__ha_restart",
  "mcp__ha-mcp__ha_reload_core",
  "mcp__ha-mcp__ha_config_set_automation",
  "mcp__ha-mcp__ha_config_delete_automation",
  "mcp__ha-mcp__ha_config_set_dashboard",
  "mcp__ha-mcp__ha_config_delete_dashboard",
  "mcp__ha-mcp__ha_call_service",
  "mcp__ha-mcp__ha_backup_restore",
  // Built-in filesystem write tools
  "Bash",
  "Write",
  "Edit",
];

// Built-in SDK tools use a different permission response format than MCP tools
const BUILTIN_TOOLS = new Set([
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
]);

export class AgentRunner {
  private config: Config;
  private abortController: AbortController | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async runQuery(
    prompt: string,
    resumeSessionId: string | null,
    callbacks: AgentCallbacks,
    images?: ImageAttachment[] | null,
    conversationHistory?: ChatMessage[],
  ): Promise<void> {
    // If resume fails (stale session), retry once without resume — include history for context
    try {
      await this._runQueryInner(prompt, resumeSessionId, callbacks, images, conversationHistory);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (resumeSessionId && (message.includes("No conversation found") || message.includes("session"))) {
        debug("agent", `resume failed (stale session), retrying without resume: ${message}`);
        await this._runQueryInner(prompt, null, callbacks, images, conversationHistory);
      } else {
        throw err;
      }
    }
  }

  private async _runQueryInner(
    prompt: string,
    resumeSessionId: string | null,
    callbacks: AgentCallbacks,
    images?: ImageAttachment[] | null,
    conversationHistory?: ChatMessage[],
  ): Promise<void> {
    this.abortController = new AbortController();

    const toolCalls: ToolCallInfo[] = [];
    let fullText = "";
    let agentSessionId = "";
    let usage: TokenUsage | null = null;
    let costUsd: number | null = null;

    debug("agent", `runQuery start`, {
      model: this.config.model,
      mcpUrl: this.config.haMcpUrl,
      resumeSessionId,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 120),
      hasAnthropicApiKey: !!process.env.ANTHROPIC_API_KEY,
      hasOauthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      oauthTokenPrefix: process.env.CLAUDE_CODE_OAUTH_TOKEN?.substring(0, 20),
    });

    try {
      // When not resuming an SDK session, inject conversation history into the system prompt
      // so Claude has context from prior turns (survives add-on rebuilds / stale sessions)
      let systemPrompt = buildSystemPrompt();
      if (!resumeSessionId && conversationHistory && conversationHistory.length > 0) {
        const historyBlock = formatConversationHistory(conversationHistory);
        debug("agent", `injecting conversation history into system prompt`, {
          messageCount: conversationHistory.length,
          historyLength: historyBlock.length,
        });
        systemPrompt += historyBlock;
      }

      const options: Record<string, unknown> = {
        model: this.config.model,
        systemPrompt,
        tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        cwd: "/config",
        allowedTools: ["mcp__ha-mcp__*"],
        mcpServers: {
          "ha-mcp": {
            type: "http" as const,
            url: this.config.haMcpUrl,
          },
        },
        includePartialMessages: true,
        abortController: this.abortController,
        maxTurns: 50,
        persistSession: true,
        canUseTool: async (
          toolName: string,
          input: unknown,
          context: { toolUseID: string },
        ) => {
          const isBuiltin = BUILTIN_TOOLS.has(toolName);
          // Built-in tools require updatedInput alongside behavior: "allow"
          const allowResult = isBuiltin
            ? { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
            : { behavior: "allow" as const };
          const denyResult = {
            behavior: "deny" as const,
            message: "User denied this operation.",
          };

          // Auto-approve read-only tools
          if (READ_ONLY_TOOLS.includes(toolName)) {
            debug("agent", `auto-approving read-only tool: ${toolName}`, input);
            return allowResult;
          }

          // Require approval for destructive tools
          if (DESTRUCTIVE_TOOLS.includes(toolName)) {
            debug("agent", `requesting approval for destructive tool: ${toolName}`, input);
            const result = await callbacks.onApprovalNeeded(
              context.toolUseID,
              toolName,
              input,
            );
            debug("agent", `tool approval result: ${result.approved ? "approved" : "denied"} for ${toolName}`);
            if (result.approved) {
              // Notify if this is a restart tool
              if (RESTART_TOOLS.includes(toolName)) {
                callbacks.onRestartDetected?.(toolName);
              }
              return allowResult;
            }
            return {
              behavior: "deny" as const,
              message: result.denyMessage
                ? `User instruction: ${result.denyMessage}`
                : "User denied this operation.",
            };
          }

          // Default: allow other ha-mcp tools
          debug("agent", `auto-approving tool: ${toolName}`);
          return allowResult;
        },
      };

      if (resumeSessionId) {
        (options as Record<string, unknown>).resume = resumeSessionId;
      }

      // Build prompt: use AsyncIterable<SDKUserMessage> when images are attached
      let promptInput: string | AsyncIterable<SDKUserMessage>;
      if (images && images.length > 0) {
        debug("agent", `building image prompt with ${images.length} image(s)`);
        const contentBlocks = [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
          { type: "text" as const, text: prompt },
        ];
        async function* makePrompt(): AsyncIterable<SDKUserMessage> {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: contentBlocks },
            parent_tool_use_id: null,
            session_id: "",
          };
        }
        promptInput = makePrompt();
      } else {
        promptInput = prompt;
      }

      const q = query({ prompt: promptInput, options });

      for await (const message of q) {
        // Detect stale session error from SDK result message
        if (message.type === "result") {
          const result = message as Record<string, unknown>;
          if (result.subtype === "error_during_execution" && Array.isArray(result.errors)) {
            const errorStr = (result.errors as string[]).join(" ");
            if (resumeSessionId && errorStr.includes("No conversation found")) {
              debug("agent", `stale session detected in result message, will retry`);
              throw new Error(`No conversation found with session ID: ${resumeSessionId}`);
            }
          }
        }

        this.processMessage(message, callbacks, toolCalls, {
          getText: () => fullText,
          setText: (t: string) => { fullText = t; },
          setSessionId: (id: string) => { agentSessionId = id; },
          setUsage: (u: TokenUsage) => { usage = u; },
          setCost: (c: number) => { costUsd = c; },
        });
      }

      debug("agent", `runQuery complete`, {
        agentSessionId,
        toolCallCount: toolCalls.length,
        textLength: fullText.length,
        costUsd,
        usage,
      });
      callbacks.onComplete({
        text: fullText,
        toolCalls,
        sessionId: agentSessionId,
        usage,
        costUsd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("aborted")) {
        debug("agent", "runQuery cancelled by user");
        callbacks.onComplete({
          text: fullText + "\n\n*[Cancelled]*",
          toolCalls,
          sessionId: agentSessionId,
          usage,
          costUsd,
        });
      } else if (resumeSessionId && message.includes("No conversation found")) {
        // Re-throw so the outer runQuery can retry without resume
        throw err;
      } else {
        debug("agent", `runQuery error: ${message}`);
        callbacks.onError(message);
      }
    } finally {
      this.abortController = null;
    }
  }

  private processMessage(
    message: SDKMessage,
    callbacks: AgentCallbacks,
    toolCalls: ToolCallInfo[],
    state: {
      getText: () => string;
      setText: (t: string) => void;
      setSessionId: (id: string) => void;
      setUsage: (u: TokenUsage) => void;
      setCost: (c: number) => void;
    },
  ): void {
    debug("agent", `SDK message: type=${message.type}${"subtype" in message ? ` subtype=${(message as { subtype: string }).subtype}` : ""}`, message);

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          const sessionId = (message as { session_id: string }).session_id;
          debug("agent", `SDK session initialized: ${sessionId}`);
          state.setSessionId(sessionId);
        }
        break;

      case "stream_event": {
        const event = (message as { event: Record<string, unknown> }).event;
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            state.setText(state.getText() + delta.text);
            callbacks.onStreamText(delta.text);
          }
        }
        break;
      }

      case "assistant": {
        const msg = (message as { message: { content: Array<Record<string, unknown>> } }).message;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "tool_use") {
              debug("agent", `tool_use: ${block.name as string}`, block.input);
              const toolCall: ToolCallInfo = {
                id: block.id as string,
                name: block.name as string,
                input: block.input,
                output: null,
                status: "running",
              };
              toolCalls.push(toolCall);
              callbacks.onToolUse(toolCall);
            }
          }
        }
        break;
      }

      case "user": {
        // Tool results come back as user messages
        const msg = (message as { message: { content: Array<Record<string, unknown>> } }).message;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              const tc = toolCalls.find((t) => t.id === block.tool_use_id);
              if (tc) {
                tc.output = block.content;
                tc.status = block.is_error ? "error" : "complete";
                debug("agent", `tool_result: ${tc.name} status=${tc.status}`, block.content);
                callbacks.onToolUse(tc);
              }
            }
          }
        }
        break;
      }

      case "result": {
        const result = message as Record<string, unknown>;
        debug("agent", `result: subtype=${result.subtype} cost=$${result.total_cost_usd}`);
        if (typeof result.total_cost_usd === "number") {
          state.setCost(result.total_cost_usd);
        }
        if (result.subtype === "success" && typeof result.session_id === "string") {
          state.setSessionId(result.session_id);
        }
        break;
      }
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }
}

/**
 * Format conversation history from the database into a system prompt section.
 * This is used when the Agent SDK session can't be resumed (stale after rebuild)
 * so Claude still has context from prior messages.
 */
function formatConversationHistory(messages: ChatMessage[]): string {
  // Skip the last user message — it's the current prompt being sent separately
  const history = messages.slice(0, -1);
  if (history.length === 0) return "";

  const lines: string[] = [];
  lines.push("\n\n## Conversation History\n");
  lines.push("The following is the conversation history from this session. The user's prior messages and your prior responses are reproduced below so you have full context. Continue the conversation naturally.\n");

  for (const msg of history) {
    if (msg.role === "user") {
      lines.push(`**User:** ${msg.content}`);
    } else if (msg.role === "assistant") {
      // Include tool call summaries if present
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolSummaries = msg.toolCalls.map((tc) => {
          const name = tc.name.replace(/^mcp__ha-mcp__/, "");
          const status = tc.status === "error" ? " (error)" : "";
          return `  - ${name}${status}`;
        });
        lines.push(`**Assistant:** [Used ${msg.toolCalls.length} tool(s):\n${toolSummaries.join("\n")}\n]`);
      }
      if (msg.content) {
        lines.push(`**Assistant:** ${msg.content}`);
      }
    } else if (msg.role === "system") {
      lines.push(`**System:** ${msg.content}`);
    }
    lines.push(""); // blank line separator
  }

  // Cap history to avoid bloating the prompt — keep last ~50k chars
  let result = lines.join("\n");
  if (result.length > 50000) {
    result = result.slice(-50000);
    // Find the first complete message boundary
    const firstBoundary = result.indexOf("\n**");
    if (firstBoundary > 0) {
      result = "[Earlier messages truncated]\n" + result.slice(firstBoundary);
    }
  }

  return result;
}
