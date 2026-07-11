import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchPages,
  fetchPage,
  runSearch,
  runQuery,
  fetchGraph,
  uploadFiles,
  enqueueIngest,
  fetchIngestStatus,
  fetchLint,
  fixLint,
  fetchConfig,
  updateConfig,
  fetchModels,
} from "../api";

// Fetch/DOM-level parity: the React client (web/src/lib/api.ts) must hit the
// exact same `/api/*` request shapes (method, URL, query params, JSON body)
// as the legacy vanilla-JS SPA (src/mythic_proportion/web/static/app.js).
// Each assertion below is cross-checked against the corresponding legacy
// function noted in the comment.
describe("lib/api.ts <-> legacy app.js request-shape parity", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchPages() matches legacy loadPageList(): GET /api/pages", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ pages: [] }) });
    await fetchPages();
    // fetchJsonWithTimeout adds an AbortSignal (a client-only timeout guard,
    // same resilience contract as legacy's own fetchJsonWithTimeout) -- the
    // URL is what must match the legacy request shape.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/pages");
  });

  it("fetchPage() matches legacy openPage(): GET /api/page?path=<encoded>", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await fetchPage("notes/a b.md");
    expect(fetchMock).toHaveBeenCalledWith(`/api/page?path=${encodeURIComponent("notes/a b.md")}`);
  });

  it("runSearch() matches legacy runSearch(): GET /api/search?q=<encoded>&k=8", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    await runSearch("a query", 8);
    expect(fetchMock).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent("a query")}&k=8`);
  });

  it("runQuery() matches legacy runAsk(): POST /api/query with {question, use_llm, k} JSON body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "", citations: [], hits: [], used_llm: true, error: false }),
    });
    await runQuery("what?", true, 8);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "what?", use_llm: true, k: 8 }),
      }),
    );
  });

  it("fetchGraph() matches legacy fetchGraphData(): GET /api/graph", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    await fetchGraph();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/graph");
  });

  it("uploadFiles() matches legacy uploadFiles(): POST /api/upload with a multipart FormData 'files' field", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "j1", saved: ["a.md"] }) });
    const file = new File(["x"], "a.md");
    await uploadFiles([file]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/upload");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("files")).toBeInstanceOf(File);
  });

  it("enqueueIngest() matches legacy ingest-only handler: POST /api/ingest", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ job_id: "j2" }) });
    await enqueueIngest();
    expect(fetchMock).toHaveBeenCalledWith("/api/ingest", { method: "POST" });
  });

  it("fetchIngestStatus() matches legacy pollIngestStatus(): GET /api/ingest/status?job_id=<encoded>", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "j2",
        status: "done",
        done: true,
        files: [],
        created_at: 0,
        updated_at: 0,
        ingested: 0,
        ingested_files: [],
        skipped: 0,
        compiled: 0,
        errors: [],
      }),
    });
    await fetchIngestStatus("job with space");
    // fetchJsonWithTimeout wraps the passed-through `{}` options with an
    // AbortSignal internally; URL + the 10000ms timeout budget are the
    // legacy-matching contract (see legacy pollIngestStatus's own
    // fetchJsonWithTimeout(url, {}, 10000) call).
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/ingest/status?job_id=${encodeURIComponent("job with space")}`,
    );
  });

  it("fetchLint() matches legacy loadLint(): GET /api/lint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        exit_code: 0,
        summary: "",
        orphans: [],
        dangling_links: [],
        stale_index_entries: [],
        thin_pages: [],
      }),
    });
    await fetchLint();
    expect(fetchMock).toHaveBeenCalledWith("/api/lint");
  });

  it("fixLint() matches legacy lint-fix-btn handler: POST /api/lint/fix", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stubs_created: [], index_report: {}, hot_refreshed: true, report: { ok: true, exit_code: 0, summary: "" } }),
    });
    await fixLint();
    expect(fetchMock).toHaveBeenCalledWith("/api/lint/fix", { method: "POST" });
  });

  it("fetchConfig() matches legacy refreshAskModelHint()/loadSettingsView(): GET /api/config", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "authhub", model: "m", authhub_base_url: "", route_alias: null, has_api_key: false }),
    });
    await fetchConfig();
    expect(fetchMock).toHaveBeenCalledWith("/api/config");
  });

  it("updateConfig() matches legacy settings-form submit: POST /api/config with {provider, model} JSON body (no api-key field)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ provider: "authhub", model: "m2", authhub_base_url: "", route_alias: null, has_api_key: false }),
    });
    await updateConfig({ provider: "authhub", model: "m2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "authhub", model: "m2" }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).not.toHaveProperty("api_key");
    expect(sentBody).not.toHaveProperty("apiKey");
  });

  it("fetchModels() matches legacy loadSettingsView(): GET /api/models", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [], current: "m", provider: "authhub" }) });
    await fetchModels();
    expect(fetchMock).toHaveBeenCalledWith("/api/models");
  });
});
