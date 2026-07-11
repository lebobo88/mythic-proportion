import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabNav, TABS } from "../TabNav";

describe("TabNav", () => {
  it("renders all seven tabs and marks the active one selected", () => {
    render(<TabNav active="Ask" onSelect={vi.fn()} />);
    for (const tab of TABS) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "Ask" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Wiki" })).toHaveAttribute("aria-selected", "false");
  });

  it("calls onSelect with the clicked tab", async () => {
    const onSelect = vi.fn();
    render(<TabNav active="Wiki" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(onSelect).toHaveBeenCalledWith("Graph");
  });
});
