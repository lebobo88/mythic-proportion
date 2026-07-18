import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabNav, TABS } from "../TabNav";

// Phase 4c (plan Section 3.3/6.5): TabNav is a conformant nav-plus-links
// pattern, not the APG tabs pattern -- no `role="tab"`/`role="tablist"`/
// `aria-selected`/`aria-controls`+`role="tabpanel"` pairing, and no roving
// tabindex/arrow-key handling (nav-plus-links relies on ordinary Tab-key
// focus order, which every plain `<button>` already gets for free). Current
// page is communicated via `aria-current="page"` plus a non-color cue
// (underline + bold weight -- see tab-nav.css). Each item is a real `<a>`
// with an `/app/<tab>` href (matching `App.tsx`'s existing `tabFromPathname`
// convention), so it is also right-click/middle-click/open-in-new-tab
// friendly, not merely a JS-only click target.
describe("TabNav", () => {
  it("renders all seven tabs as plain nav links (not APG tabs) and marks the active one via aria-current", () => {
    render(<TabNav active="Ask" onSelect={vi.fn()} />);
    for (const tab of TABS) {
      expect(screen.getByRole("link", { name: tab })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Ask" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Wiki" })).not.toHaveAttribute("aria-current");
    // Never the APG tabs pattern -- see the defect this fixes (plan Section 3.3).
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("calls onSelect with the clicked tab", async () => {
    const onSelect = vi.fn();
    render(<TabNav active="Wiki" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("link", { name: "Graph" }));
    expect(onSelect).toHaveBeenCalledWith("Graph");
  });

  it("gives the active tab a non-color cue class in addition to aria-current (never color alone)", () => {
    render(<TabNav active="Graph" onSelect={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Graph" })).toHaveClass("mp-tab--active");
    expect(screen.getByRole("link", { name: "Wiki" })).not.toHaveClass("mp-tab--active");
  });

  it("every tab is reachable via ordinary Tab-key focus order (nav-plus-links needs no roving tabindex)", () => {
    render(<TabNav active="Wiki" onSelect={vi.fn()} />);
    for (const tab of TABS) {
      expect(screen.getByRole("link", { name: tab })).not.toHaveAttribute("tabindex", "-1");
    }
  });
});
