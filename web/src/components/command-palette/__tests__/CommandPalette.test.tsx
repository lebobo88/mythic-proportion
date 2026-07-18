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

  // Phase 4d (plan Section 6.6 item 1; Section 9.3 journey 7 acceptance bar):
  // "Cmd+K ... supports arrow-key navigation and Enter to navigate".
  it("arrow-key navigation plus Enter selects the highlighted item and navigates", async () => {
    const onSelectTab = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSelectTab={onSelectTab} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = screen.getByPlaceholderText(/type a command/i);
    await user.type(input, "Search");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onSelectTab).toHaveBeenCalledWith("Search");
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument();
  });

  // Defined "no results" state (Section 9.3 journey 7 acceptance bar).
  it("shows the defined empty/no-results state for a query matching nothing", async () => {
    render(<Harness onSelectTab={vi.fn()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    await userEvent.type(screen.getByPlaceholderText(/type a command/i), "zzzznomatch");

    expect(await screen.findByText("No matching command or page.")).toBeInTheDocument();
  });

  // Defined "empty" (nothing typed yet) state: the full command set is
  // immediately browsable/reachable by keyboard, not a blank dialog.
  it("shows the defined empty (nothing-typed-yet) state with the full navigable command set", async () => {
    render(<Harness onSelectTab={vi.fn()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByPlaceholderText(/type a command/i)).toHaveValue("");
    expect(screen.getByText("Switch to Wiki")).toBeInTheDocument();
    expect(screen.getByText("Run Ask")).toBeInTheDocument();
    expect(screen.queryByText("No matching command or page.")).not.toBeInTheDocument();
  });
});
