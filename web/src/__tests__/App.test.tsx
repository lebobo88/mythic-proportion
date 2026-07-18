import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { tabFromPathname } from "../App";
import App from "../App";

// Browser-audit item 2 residual: a direct load of a path-style URL like
// `/app/graph` must select the matching tab instead of always defaulting to
// Wiki. The server-side SPA fallback (already fixed) guarantees the shell
// itself loads; this covers the remaining client-side tab-selection gap.
//
// Phase 4c (plan Section 3.3/6.5, the graph state-lifecycle defect): this
// stub carries its own `useState` counter specifically so the lifecycle
// tests below can prove GraphView is never unmounted across a tab excursion
// -- React component state does not survive a real unmount/remount, so a
// counter that still reads its pre-excursion value after returning to the
// Graph tab is direct behavioral evidence of "mounted-hidden", not merely a
// structural/regex assertion against App.tsx's source. `visible` is
// rendered into a data attribute so the pause-when-hidden wiring (passed
// through to Graph3DScene as `paused`) can be asserted too.
vi.mock("../routes/graph/GraphView", () => {
  function GraphViewStub({
    onOpenPage,
    visible,
  }: {
    onOpenPage: (path: string) => void;
    onGoToIngest?: () => void;
    visible?: boolean;
  }) {
    const [selections, setSelections] = useState(0);
    return (
      <div data-testid="graph-view-stub" data-visible={String(visible)}>
        <p>Selections: {selections}</p>
        <button type="button" onClick={() => setSelections((n) => n + 1)}>
          Select node
        </button>
        <button type="button" onClick={() => onOpenPage("some/page")}>
          Open in Wiki
        </button>
      </div>
    );
  }
  return { GraphView: GraphViewStub, default: GraphViewStub };
});

describe("tabFromPathname", () => {
  it("maps a known /app/<tab> path segment to the matching tab, case-insensitively", () => {
    expect(tabFromPathname("/app/graph")).toBe("Graph");
    expect(tabFromPathname("/app/Graph")).toBe("Graph");
    expect(tabFromPathname("/app/SEARCH")).toBe("Search");
    expect(tabFromPathname("/app/settings")).toBe("Settings");
  });

  it("returns null for the bare /app root, an unknown segment, or a non-/app path", () => {
    expect(tabFromPathname("/app")).toBeNull();
    expect(tabFromPathname("/app/")).toBeNull();
    expect(tabFromPathname("/app/not-a-tab")).toBeNull();
    expect(tabFromPathname("/")).toBeNull();
  });

  it("only matches the first path segment (ignores anything nested/appended after it)", () => {
    expect(tabFromPathname("/app/graph/extra")).toBe("Graph");
    expect(tabFromPathname("/app/graph?x=1")).toBe("Graph");
  });
});

describe("App initial tab selection from a direct path-style load", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pages: [] }) });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("selects the Graph tab when the app is loaded directly at /app/graph", async () => {
    window.history.pushState({}, "", "/app/graph");

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("graph-view-stub")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Graph" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Wiki" })).not.toHaveAttribute("aria-current");
  });

  it("still defaults to the Wiki tab when loaded at the bare /app root", async () => {
    window.history.pushState({}, "", "/app");

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Wiki" })).toHaveAttribute("aria-current", "page"),
    );
  });
});

// Phase 4c (plan Section 3.3/6.5): the graph state-lifecycle fix. Before
// this fix, `App.tsx` rendered `{activeTab === "Graph" ? <GraphView/> :
// null}`, which destroyed GraphView (its worker, physics state, selection,
// filters, expanded-node set) on every tab switch away from Graph --
// including the built-in "Open in Wiki" action, which cold-restarted
// physics on return. The fix keeps GraphView mounted-hidden once it has
// been visited at least once, instead of conditionally mounting/unmounting
// it on every tab change.
describe("App keeps GraphView mounted-hidden across tab excursions (graph state-lifecycle fix)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Branches by URL: the "Open in Wiki" round trip navigates to WikiView,
    // which fetches a single page's detail (`/api/page?path=...`) in
    // addition to the page list -- a plain one-shape-fits-all mock would
    // hand WikiView's `PageDetail` renderer a `{pages: []}` object instead
    // (crashing on `page.tags.map`).
    fetchMock = vi.fn((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/page?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            path: "some/page",
            title: "Some Page",
            type: "note",
            tags: [],
            frontmatter: {},
            raw_markdown: "",
            html: "<p>Some page</p>",
            outbound: [],
            backlinks: [],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ pages: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("never mounts GraphView at all before the Graph tab has been visited", () => {
    render(<App />);
    expect(screen.queryByTestId("graph-view-stub")).not.toBeInTheDocument();
  });

  it("survives the built-in Open-in-Wiki round trip with no state loss and no remount", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Graph" }));
    const graphView = await screen.findByTestId("graph-view-stub");
    expect(graphView).toHaveAttribute("data-visible", "true");

    // Build up in-component state a real unmount/remount would destroy.
    await user.click(screen.getByRole("button", { name: "Select node" }));
    await user.click(screen.getByRole("button", { name: "Select node" }));
    expect(screen.getByText("Selections: 2")).toBeInTheDocument();

    // The built-in "Open in Wiki" action: GraphView calls onOpenPage, which
    // App.tsx wires to openPage -- switching the active tab to Wiki.
    await user.click(screen.getByRole("button", { name: "Open in Wiki" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Wiki" })).toHaveAttribute("aria-current", "page"));

    // GraphView stays in the DOM (mounted-hidden), not removed -- and its
    // state survived, proving no real unmount/remount happened.
    const hiddenGraphView = screen.getByTestId("graph-view-stub");
    expect(hiddenGraphView).toBeInTheDocument();
    expect(screen.getByText("Selections: 2")).toBeInTheDocument();
    expect(hiddenGraphView).toHaveAttribute("data-visible", "false");
    expect(hiddenGraphView.closest("[hidden]")).not.toBeNull();

    // Switching back to Graph shows the exact same instance again, state intact.
    await user.click(screen.getByRole("link", { name: "Graph" }));
    await waitFor(() => expect(screen.getByTestId("graph-view-stub")).toHaveAttribute("data-visible", "true"));
    expect(screen.getByText("Selections: 2")).toBeInTheDocument();
    expect(screen.getByTestId("graph-view-stub").closest("[hidden]")).toBeNull();
  });

  it("survives any other tab excursion (not just Open-in-Wiki), e.g. a manual switch to Settings and back", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Graph" }));
    await screen.findByTestId("graph-view-stub");
    await user.click(screen.getByRole("button", { name: "Select node" }));
    expect(screen.getByText("Selections: 1")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByTestId("graph-view-stub").closest("[hidden]")).not.toBeNull();

    await user.click(screen.getByRole("link", { name: "Graph" }));
    expect(screen.getByText("Selections: 1")).toBeInTheDocument();
  });
});
