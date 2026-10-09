import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPrompt } from "./ApprovalPrompt";

function renderPrompt() {
  const callbacks = {
    onApprove: vi.fn(),
    onApproveAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyWithMessage: vi.fn(),
  };
  render(
    <ApprovalPrompt
      toolName="mcp__ha-mcp__ha_call_service"
      input={{ entity_id: "light.kitchen", brightness: 42 }}
      onApprove={callbacks.onApprove}
      onApproveAlways={callbacks.onApproveAlways}
      onDeny={callbacks.onDeny}
      onDenyWithMessage={callbacks.onDenyWithMessage}
    />,
  );
  return callbacks;
}

describe("ApprovalPrompt", () => {
  it("shows the tool name with the mcp prefix stripped", () => {
    renderPrompt();
    expect(screen.getByText("ha_call_service")).toBeTruthy();
    expect(screen.getByText("Approval Required")).toBeTruthy();
  });

  it("calls onApprove for Approve and onDeny for Deny", () => {
    const callbacks = renderPrompt();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(callbacks.onApprove).toHaveBeenCalledTimes(1);
    expect(callbacks.onDeny).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
    expect(callbacks.onApproveAlways).not.toHaveBeenCalled();
  });

  it("offers 'allow and always allow' through the dropdown", () => {
    const callbacks = renderPrompt();

    fireEvent.click(screen.getByRole("button", { name: "More approve options" }));
    fireEvent.click(screen.getByRole("button", { name: /Allow and always allow ha_call_service/ }));

    expect(callbacks.onApproveAlways).toHaveBeenCalledTimes(1);
    expect(callbacks.onApprove).not.toHaveBeenCalled();
  });

  it("denies with typed instructions and keeps Send disabled while empty", () => {
    const callbacks = renderPrompt();

    fireEvent.click(screen.getByRole("button", { name: "Provide instructions" }));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Tell Claude what to do instead..."), {
      target: { value: "  stop and ask me first  " },
    });
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    expect(callbacks.onDenyWithMessage).toHaveBeenCalledTimes(1);
    expect(callbacks.onDenyWithMessage).toHaveBeenCalledWith("stop and ask me first");
    expect(callbacks.onDeny).not.toHaveBeenCalled();
  });
});
