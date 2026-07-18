import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { WikiView } from "../WikiView";
import { usePages } from "../../../lib/usePages";

// Harness mirrors how App.tsx wires WikiView: usePages() drives the
// `/api/pages` fetch, WikiView itself drives `/api/page` on selection.
function Harness() {
  const { pages, error } = usePages();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return (
    <WikiView
      pages={pages}
      pagesError={error}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    />
  );
}

const PAGE_DETAIL = {
  path: "notes/alpha.md",
  title: "Alpha",
  type: "concept",
  tags: ["tag-a"],
  frontmatter: {},
  raw_markdown: "# Alpha",
  html: "<h1>Alpha</h1>",
  outbound: [],
  backlinks: [],
};

describe("WikiView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits GET /api/pages and shows the empty state when there are no pages", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ pages: [] }) });

    render(<Harness />);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/pages")).toBe(true));
    expect(await screen.findByText("No pages yet.")).toBeInTheDocument();
    expect(screen.getByText("Select a page from the list.")).toBeInTheDocument();
  });

  it("hits GET /api/page on selection and renders the populated page detail", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pages: [
          {
            path: "notes/alpha.md",
            title: "Alpha",
            type: "concept",
            tags: ["tag-a"],
            link_count: 0,
            backlink_count: 0,
          },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => PAGE_DETAIL });

    render(<Harness />);

    const item = await screen.findByText("Alpha");
    await userEvent.click(item);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/page?path=${encodeURIComponent("notes/alpha.md")}`),
    );
    expect(await screen.findByText("Backlinks (0)")).toBeInTheDocument();
    expect(screen.getByText("notes/alpha.md")).toBeInTheDocument();
  });

  // Phase 4d (plan Section 6.6 item 4; visual-system spec Section 5.1): the
  // generalized focus-plus-context-dim treatment, extended from the graph's
  // Phase 4c per-node motif into 2D list chrome app-wide -- a non-selected
  // sibling dims once something IS selected, always paired with the
  // existing non-color `--selected` border/background cue (never dim/color
  // alone).
  it("dims non-selected page-list items once a page is selected, alongside the existing non-color selected cue", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        pages: [
          {
            path: "notes/alpha.md",
            title: "Alpha",
            type: "concept",
            tags: ["tag-a"],
            link_count: 0,
            backlink_count: 0,
          },
          {
            path: "notes/beta.md",
            title: "Beta",
            type: "concept",
            tags: [],
            link_count: 0,
            backlink_count: 0,
          },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => PAGE_DETAIL });

    render(<Harness />);
    const alphaItem = await screen.findByText("Alpha");
    const betaItem = await screen.findByText("Beta");
    expect(alphaItem.closest("button")).not.toHaveClass("mp-context-dimmed");
    expect(betaItem.closest("button")).not.toHaveClass("mp-context-dimmed");

    await userEvent.click(alphaItem);

    expect(alphaItem.closest("button")).toHaveClass("mp-wiki-page-item--selected");
    expect(alphaItem.closest("button")).not.toHaveClass("mp-context-dimmed");
    expect(betaItem.closest("button")).toHaveClass("mp-context-dimmed");
  });
});
