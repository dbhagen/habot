import { useState, useRef, useEffect } from "react";
import { ToolInputDisplay } from "./ToolInputDisplay";
import { debug } from "../utils/debug";

interface ApprovalPromptProps {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onApproveAlways: () => void;
  onDeny: () => void;
  onDenyWithMessage: (message: string) => void;
}

export function ApprovalPrompt({
  toolName,
  input,
  onApprove,
  onApproveAlways,
  onDeny,
  onDenyWithMessage,
}: ApprovalPromptProps) {
  const displayName = toolName.replace(/^mcp__ha-mcp__/, "");
  const [showDropdown, setShowDropdown] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructions, setInstructions] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showDropdown]);

  // Focus instructions textarea when shown
  useEffect(() => {
    if (showInstructions && instructionsRef.current) {
      instructionsRef.current.focus();
    }
  }, [showInstructions]);

  const handleSendInstructions = () => {
    const trimmed = instructions.trim();
    if (trimmed) {
      debug("tools", `denying with instructions: ${trimmed.substring(0, 80)}`);
      onDenyWithMessage(trimmed);
    }
  };

  const handleInstructionsKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendInstructions();
    }
    if (e.key === "Escape") {
      setShowInstructions(false);
      setInstructions("");
    }
  };

  return (
    <div className="approval-prompt">
      <div className="approval-header">
        Approval Required
      </div>
      <div className="approval-body">
        <p>
          Claude wants to call <strong>{displayName}</strong>
        </p>
        <ToolInputDisplay toolName={toolName} input={input} />
      </div>
      <div className="approval-actions">
        <div className="approve-split-btn" ref={dropdownRef}>
          <button className="btn-approve" onClick={onApprove}>
            Approve
          </button>
          <button
            className="btn-approve-dropdown"
            onClick={() => setShowDropdown(!showDropdown)}
            aria-label="More approve options"
          >
            <span className="dropdown-arrow">&#9662;</span>
          </button>
          {showDropdown && (
            <div className="approve-dropdown-menu">
              <button
                className="approve-dropdown-item"
                onClick={() => {
                  setShowDropdown(false);
                  debug("tools", `user chose always-allow for tool=${displayName}`);
                  onApproveAlways();
                }}
              >
                Allow and always allow <strong>{displayName}</strong>
              </button>
            </div>
          )}
        </div>
        <button className="btn-deny" onClick={onDeny}>
          Deny
        </button>
        <button
          className="btn-instructions"
          onClick={() => setShowInstructions(!showInstructions)}
        >
          Provide instructions
        </button>
      </div>
      {showInstructions && (
        <div className="approval-instructions">
          <textarea
            ref={instructionsRef}
            className="instructions-input"
            placeholder="Tell Claude what to do instead..."
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={handleInstructionsKeyDown}
            rows={2}
          />
          <button
            className="btn-send-instructions"
            onClick={handleSendInstructions}
            disabled={!instructions.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
