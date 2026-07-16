import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { CommandPalette } from "../CommandPalette";
import type { TabName } from "../../shell/TabNav";

function Harness({ onSelectTab }: { onSelectTab: (tab: TabName) => void }) {
  const [open, setOpen] = useState(false);
  return <CommandPalette open={open} onOpenChange={setOpen} onSelectTab={onSelectTab} />;
}

describe("CommandPalette", () => {
  it("opens on Cmd+K / Ctrl+K", () => {
    render(<Harness onSelectTab={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByPlaceholderText(/type a command/i)).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<Harness onSelectTab={vi.fn()} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByPlaceholderText(/type a command/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
  });

  it("selecting a 'switch tab' item calls onSelectTab and closes the palette", async () => {
    const onSelectTab = vi.fn();
    render(<Harness onSelectTab={onSelectTab} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const item = await screen.findByText("Switch to Graph");
    await userEvent.click(item);

    expect(onSelectTab).toHaveBeenCalledWith("Graph");
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
  });
});
