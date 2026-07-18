import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageDetailPane } from "../PageDetailPane";

// Phase 4d (plan Section 6.6 item 1): the shared "first-class reading/detail
// pane" used by any view that needs to show a `PageDetail` alongside a list
// (Search, Ask) without navigating away -- Wiki and Graph already have their
// own equivalent panes (Phase 3/4c, hard-preserved, not touched by this
// component). All four states named in the plan's acceptance bar (Section
// 9.3 journey 7): loading, empty, error, populated.
describe("PageDetailPane", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no path is selected", () => {
    render(<PageDetailPane path={null} onOpenInWiki={vi.fn()} />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the loading state while the page fetch is in flight", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    render(<PageDetailPane path="notes/alpha.md" onOpenInWiki={vi.fn()} />);
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    resolveFetch({
      ok: true,
      json: async () => ({
        path: "notes/alpha.md",
        title: "Alpha",
        type: "source",
        tags: [],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Alpha body</p>",
        outbound: [],
        backlinks: [],
      }),
    });
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });

  it("shows the error state when the fetch fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    render(<PageDetailPane path="missing.md" onOpenInWiki={vi.fn()} />);
    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
  });

  it("shows the populated state and calls onOpenInWiki from its explicit action", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        path: "notes/alpha.md",
        title: "Alpha",
        type: "source",
        tags: ["one"],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Alpha body</p>",
        outbound: [],
        backlinks: [],
      }),
    });
    const onOpenInWiki = vi.fn();
    render(<PageDetailPane path="notes/alpha.md" onOpenInWiki={onOpenInWiki} />);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Alpha body")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open in wiki/i }));
    expect(onOpenInWiki).toHaveBeenCalledWith("notes/alpha.md");
  });

  it("re-fetches and clears stale content when the path changes", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        path: "notes/alpha.md",
        title: "Alpha",
        type: "source",
        tags: [],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Alpha body</p>",
        outbound: [],
        backlinks: [],
      }),
    });
    const { rerender } = render(<PageDetailPane path="notes/alpha.md" onOpenInWiki={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();

    let resolveSecond: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    rerender(<PageDetailPane path="notes/beta.md" onOpenInWiki={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();

    resolveSecond({
      ok: true,
      json: async () => ({
        path: "notes/beta.md",
        title: "Beta",
        type: "source",
        tags: [],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Beta body</p>",
        outbound: [],
        backlinks: [],
      }),
    });
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
  });
});
