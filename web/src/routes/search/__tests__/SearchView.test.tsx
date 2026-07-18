import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchView } from "../SearchView";

describe("SearchView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fetch and shows nothing for an empty query", () => {
    render(<SearchView onOpenPage={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("No results.")).not.toBeInTheDocument();
  });

  it("hits GET /api/search and shows the empty-results state", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    render(<SearchView onOpenPage={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Search"), "nothing");

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent("nothing")}&k=8`),
      { timeout: 2000 },
    );
    expect(await screen.findByText("No results.")).toBeInTheDocument();
  });

  it("hits GET /api/search and renders populated results", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            page_path: "notes/alpha.md",
            title: "Alpha",
            score: 0.9231,
            snippet: "alpha snippet",
            snippet_html: "<mark>alpha</mark> snippet",
            tier: "exact",
          },
        ],
      }),
    });
    render(<SearchView onOpenPage={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Search"), "alpha");

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent("alpha")}&k=8`),
      { timeout: 2000 },
    );

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText(/exact.*score 0\.923/)).toBeInTheDocument();
  });

  // Phase 4d (plan Section 6.6 item 1; Section 9.3 journey 7): a first-class
  // reading/detail pane now lives IN Search itself -- selecting a result no
  // longer immediately navigates away to Wiki (the old `onOpenPage`-on-click
  // behavior); it shows the page detail in place, with an explicit "Open in
  // Wiki" action inside the pane for the deliberate round trip.
  it("selecting a result shows its detail in the in-place reading pane, with loading/populated states", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            page_path: "notes/alpha.md",
            title: "Alpha",
            score: 0.9231,
            snippet: "alpha snippet",
            snippet_html: "<mark>alpha</mark> snippet",
            tier: "exact",
          },
        ],
      }),
    });
    render(<SearchView onOpenPage={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Search"), "alpha");
    const card = await screen.findByText("Alpha");

    expect(screen.getByText(/select a result/i)).toBeInTheDocument();

    let resolvePage: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    await userEvent.click(card);
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();

    resolvePage({
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
    expect(await screen.findByText("Alpha body")).toBeInTheDocument();
  });

  it("the detail pane's 'Open in Wiki' action calls onOpenPage with the selected result's path", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            page_path: "notes/alpha.md",
            title: "Alpha",
            score: 0.9231,
            snippet: "alpha snippet",
            snippet_html: "<mark>alpha</mark> snippet",
            tier: "exact",
          },
        ],
      }),
    });
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
    const onOpenPage = vi.fn();
    render(<SearchView onOpenPage={onOpenPage} />);

    await userEvent.type(screen.getByLabelText("Search"), "alpha");
    const card = await screen.findByText("Alpha");
    await userEvent.click(card);

    await userEvent.click(await screen.findByRole("button", { name: /open in wiki/i }));
    expect(onOpenPage).toHaveBeenCalledWith("notes/alpha.md");
  });
});
