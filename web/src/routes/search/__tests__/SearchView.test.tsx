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

  it("hits GET /api/search and renders populated results; clicking opens the page", async () => {
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
    const onOpenPage = vi.fn();
    render(<SearchView onOpenPage={onOpenPage} />);

    await userEvent.type(screen.getByLabelText("Search"), "alpha");

    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent("alpha")}&k=8`),
      { timeout: 2000 },
    );

    const card = await screen.findByText("Alpha");
    expect(screen.getByText(/exact.*score 0\.923/)).toBeInTheDocument();
    await userEvent.click(card);
    expect(onOpenPage).toHaveBeenCalledWith("notes/alpha.md");
  });
});
