import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IngestView } from "../IngestView";

describe("IngestView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the empty state (dropzone only, no fetch) before any upload", () => {
    render(<IngestView onIngestComplete={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Drop files here, or click to choose files.")).toBeInTheDocument();
    expect(screen.queryByText(/Ingested:/)).not.toBeInTheDocument();
  });

  it("hits POST /api/upload then GET /api/ingest/status and renders the populated, completed job", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: "job-1", saved: ["a.md"] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "job-1",
        status: "done",
        done: true,
        files: [{ name: "a.md", status: "done", message: null }],
        created_at: 0,
        updated_at: 1,
        ingested: 1,
        ingested_files: ["a.md"],
        skipped: 0,
        compiled: 1,
        errors: [],
      }),
    });

    const onIngestComplete = vi.fn();
    render(<IngestView onIngestComplete={onIngestComplete} />);

    const file = new File(["content"], "a.md", { type: "text/markdown" });
    const input = document.querySelector(".mp-ingest-file-input") as HTMLInputElement;
    await userEvent.upload(input, file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/upload", expect.objectContaining({ method: "POST" })));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ingest/status?job_id=job-1",
        expect.anything(),
      ),
    );

    await screen.findByText(/Done/);
    const panels = document.querySelectorAll(".mp-ingest-panel");
    const summaryPanel = panels[panels.length - 1];
    expect(summaryPanel.textContent).toContain("Ingested: 1");
    expect(summaryPanel.textContent).toContain("Compiled: 1");
    expect(summaryPanel.textContent).toContain("Skipped (duplicates): 0");
    expect(summaryPanel.textContent).toContain("Errors: 0");
    await waitFor(() => expect(onIngestComplete).toHaveBeenCalled());
  });

  it("hits POST /api/ingest for the 'Ingest drop/ folder' button", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "job-2" }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "job-2",
        status: "done",
        done: true,
        files: [],
        created_at: 0,
        updated_at: 1,
        ingested: 0,
        ingested_files: [],
        skipped: 0,
        compiled: 0,
        errors: [],
      }),
    });

    render(<IngestView onIngestComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Ingest drop/ folder" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ingest", expect.objectContaining({ method: "POST" })));
  });
});
