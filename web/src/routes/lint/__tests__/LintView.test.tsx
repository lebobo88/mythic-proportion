import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LintView } from "../LintView";

describe("LintView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits GET /api/lint and shows the clean/empty state", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        exit_code: 0,
        summary: "Vault is clean: no orphans, no dangling links.",
        orphans: [],
        dangling_links: [],
        stale_index_entries: [],
        thin_pages: [],
      }),
    });

    render(<LintView />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/lint"));
    expect(await screen.findByText("Vault is clean: no orphans, no dangling links.")).toBeInTheDocument();
  });

  it("hits GET /api/lint and renders populated issue sections", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: false,
        exit_code: 1,
        summary: "issues found",
        orphans: [{ title: "Orphan A", path: "notes/orphan.md" }],
        dangling_links: [
          { source_title: "Alpha", source_path: "notes/alpha.md", target_title: "Missing" },
        ],
        stale_index_entries: [{ page_path: "notes/stale.md", reason: "hash mismatch" }],
        thin_pages: [{ title: "Thin", path: "notes/thin.md", char_count: 12 }],
      }),
    });

    render(<LintView />);

    expect(await screen.findByText("Orphan pages (1)")).toBeInTheDocument();
    expect(screen.getByText("Orphan A (notes/orphan.md)")).toBeInTheDocument();
    expect(screen.getByText("Broken wikilinks (1)")).toBeInTheDocument();
    expect(screen.getByText("Stale index rows (1)")).toBeInTheDocument();
    expect(screen.getByText("Thin pages (1)")).toBeInTheDocument();
  });

  it("hits POST /api/lint/fix and reloads the report", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: false,
        exit_code: 1,
        summary: "issues found",
        orphans: [],
        dangling_links: [],
        stale_index_entries: [],
        thin_pages: [],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stubs_created: [], index_report: {}, hot_refreshed: true, report: { ok: true, exit_code: 0, summary: "fixed" } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        exit_code: 0,
        summary: "Vault is clean: no orphans, no dangling links.",
        orphans: [],
        dangling_links: [],
        stale_index_entries: [],
        thin_pages: [],
      }),
    });

    render(<LintView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Fix issues" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/lint/fix", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Vault is clean: no orphans, no dangling links.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
