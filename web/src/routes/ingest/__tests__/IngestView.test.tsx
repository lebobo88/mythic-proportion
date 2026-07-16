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

  // GraphRAG extraction pipeline bugfix (DEFECT 1 -- "extraction is never
  // invoked by any real entry point"): the "Build Knowledge Graph" button.
  it("hits POST /api/index-graph then GET /api/index-graph/status and renders the result", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "graph-job-1" }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "graph-job-1",
        status: "done",
        done: true,
        created_at: 0,
        updated_at: 1,
        text_units_added: 3,
        text_units_updated: 0,
        text_units_deleted: 0,
        entities_upserted: 5,
        entities_deleted: 0,
        relationships_upserted: 2,
        claims_upserted: 1,
        llm_calls: 4,
        error: null,
      }),
    });

    render(<IngestView onIngestComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Build Knowledge Graph" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/index-graph", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/index-graph/status?job_id=graph-job-1", expect.anything()),
    );

    await screen.findByText(/Knowledge graph build: done/);
    expect(screen.getByText(/Entities: 5/)).toBeInTheDocument();
    expect(screen.getByText(/Relationships: 2/)).toBeInTheDocument();
  });

  it("renders a graph-build job error without crashing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "graph-job-2" }) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "graph-job-2",
        status: "done",
        done: true,
        created_at: 0,
        updated_at: 1,
        text_units_added: 0,
        text_units_updated: 0,
        text_units_deleted: 0,
        entities_upserted: 0,
        entities_deleted: 0,
        relationships_upserted: 0,
        claims_upserted: 0,
        llm_calls: 0,
        error: "AUTHHUB_API_KEY is not set",
      }),
    });

    render(<IngestView onIngestComplete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Build Knowledge Graph" }));

    await screen.findByText(/AUTHHUB_API_KEY is not set/);
  });
});
