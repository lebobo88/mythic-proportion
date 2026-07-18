// Typed fetch wrappers over the existing FastAPI `/api/*` routes (see
// src/mythic_proportion/web/app.py). Every shape here is a 1:1 mirror of
// what that module actually returns/accepts -- this file intentionally adds
// no client-side re-interpretation of the payloads, so the React views stay
// byte-identical in behavior to the legacy vanilla-JS SPA
// (src/mythic_proportion/web/static/app.js) that talks to the same routes.

export interface PageListItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  link_count: number;
  backlink_count: number;
}

export interface PageLink {
  title: string;
  path: string | null;
}

export interface PageDetail {
  path: string;
  title: string;
  type: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  raw_markdown: string;
  html: string;
  outbound: PageLink[];
  backlinks: PageLink[];
}

export interface SearchHit {
  page_path: string;
  title: string;
  score: number;
  snippet: string;
  snippet_html: string;
  tier: string;
  //: Only present when the /api/query request carried an explicit `mode`
  //: key (see QueryResponse.mode below) -- strictly additive.
  source_kind?: string;
}

export interface QueryResponse {
  text: string;
  citations: string[];
  hits: SearchHit[];
  used_llm: boolean;
  error: boolean;
  //: Present if and only if the request included an explicit `mode` key --
  //: an omitted-`mode` request always gets the exact legacy 5-key shape
  //: above with no `mode`/`mode_detail` keys (see
  //: memory/invariants.md's "POST /api/query contract -- CORRECTION").
  mode?: QueryMode;
  mode_detail?: { requested: QueryMode; resolved: string | null };
}

// Phase 4: query modes exposed by the Ask view's mode dropdown. `mode` has
// NO DEFAULT -- omitting it entirely (the dropdown's own default selection)
// takes the exact pre-Phase-4 legacy path unconditionally; explicit "auto"
// opts in to legacy-until-graph-data-exists heuristic dispatch (see
// src/mythic_proportion/query/engine.py `_resolve_mode`).
export type QueryMode = "auto" | "legacy" | "global" | "local" | "drift" | "activation";

// Phase 4b (plan Section 6.4/7): the enriched `/api/graph` per-node
// centrality projection, exactly as the SERVER sends it over the wire --
// `degree` is always present (normalized 0..1), plus at least one of
// `betweenness`/`eigenvector` (this project currently computes `eigenvector`
// only -- see the Phase 4b engineering report for the "which measure"
// rationale). This is a WIRE-only shape: `fetchGraph` collapses it down to
// the single scalar `GraphNode.centrality` below before any client code
// (including `deriveVizGraph`) ever sees a node -- see
// `collapseCentralityScore`.
export interface CentralityScores {
  degree: number;
  betweenness?: number;
  eigenvector?: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  // Phase 4b enriched `/api/graph` projection (mode=entities|both only) --
  // additive/optional; absent on a wikilinks-mode node, or on any node from
  // a pre-Phase-4b fixture/cached response. Real Leiden community id /
  // hierarchy depth (0 = coarsest); see plan Section 6.4/7.
  community?: number;
  level?: number;
  /**
   * Already the collapsed CLIENT scalar (0..1), not the server's richer
   * `CentralityScores` wire object -- `fetchGraph` does that collapse once,
   * at the network boundary (see `collapseCentralityScore`), so this field
   * matches Phase 4a's synthetic-fixture shape (`synthetic.ts`) exactly:
   * every existing renderer (`ForceLayoutClient`/`forceLayout.worker.ts`/
   * `modeForces.ts`/`terrainElevation.ts`) already reads `node.centrality`
   * as a plain number via `node.centrality ?? 0.1`. This is the plan
   * Section 5.3 "match the shape client-side code already expects" call --
   * see the Phase 4b engineering report -- so Phase 4c's real-data wiring
   * needs no second contract negotiation.
   */
  centrality?: number;
  /**
   * This node's ancestor community id at every level COARSER than its own
   * `level`/`community` -- e.g. `{0: 3}` means "this node's level-0
   * ancestor cluster is 3". Keyed by level (Phase 4b, plan Section 7).
   * Absent when the node has only one stored level (nothing to chain).
   */
  parentCommunity?: Record<number, number>;
}

export interface GraphEdge {
  source: string;
  target: string;
  // Already returned by the server for entities/both-mode edges (see
  // store.py's `read_entity_graph`) -- this was previously only declared on
  // `VizEdge` (types.ts), not here, so nothing could read it with a typed
  // `GraphEdge`/`GraphData` value. Phase 4b client-wiring-only fix (plan
  // Section 6.4): no server change, just making the existing wire field
  // visible at this type.
  weight?: number;
  type?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Collapse the server's richer per-node `CentralityScores` wire object down
 * to the single scalar every existing graph renderer expects (see
 * `GraphNode.centrality`'s doc comment above). Preference order:
 * `eigenvector` (this project's chosen primary measure -- see the Phase 4b
 * engineering report) > `betweenness` (if eigenvector wasn't computed) >
 * `degree` (always present, guaranteed fallback). Already-scalar input
 * (a plain number, e.g. from a hand-written test fixture or a future
 * fixture that already matches the client shape) passes straight through
 * unchanged -- this function is idempotent.
 */
export function collapseCentralityScore(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw;
  if (raw == null || typeof raw !== "object") return undefined;
  const scores = raw as CentralityScores;
  if (typeof scores.eigenvector === "number") return scores.eigenvector;
  if (typeof scores.betweenness === "number") return scores.betweenness;
  if (typeof scores.degree === "number") return scores.degree;
  return undefined;
}

/**
 * Normalizes a raw `/api/graph` JSON payload into this module's `GraphData`
 * shape. Currently only collapses the Phase 4b enriched `centrality` wire
 * object (see `collapseCentralityScore`) -- every other field passes
 * through completely unchanged. Exported so it's directly testable without
 * a network mock.
 */
export function normalizeGraphResponse(data: { nodes?: unknown[]; edges?: unknown[] }): GraphData {
  const nodes = (data.nodes ?? []).map((raw) => {
    const node = raw as GraphNode;
    const centrality = collapseCentralityScore(node.centrality);
    return centrality === undefined ? node : ({ ...node, centrality } as GraphNode);
  });
  return { nodes, edges: (data.edges ?? []) as GraphEdge[] };
}

export interface JobFileStatus {
  name: string;
  status: "queued" | "compiling" | "done" | "error";
  message: string | null;
}

export interface IngestJobStatus {
  id: string | null;
  status: "queued" | "running" | "done" | "idle";
  done: boolean;
  files: JobFileStatus[];
  created_at: number | null;
  updated_at: number | null;
  ingested: number;
  ingested_files: string[];
  skipped: number;
  compiled: number;
  errors: { file?: string; error?: string }[];
}

export interface OrphanPage {
  title: string;
  path: string;
}

export interface DanglingLink {
  source_title: string;
  source_path: string;
  target_title: string;
}

export interface StaleIndexEntry {
  page_path: string;
  reason: string;
}

export interface ThinPage {
  title: string;
  path: string;
  char_count: number;
}

export interface LintReport {
  ok: boolean;
  exit_code: number;
  summary: string;
  orphans: OrphanPage[];
  dangling_links: DanglingLink[];
  stale_index_entries: StaleIndexEntry[];
  thin_pages: ThinPage[];
}

export interface LintFixResponse {
  stubs_created: string[];
  index_report: Record<string, unknown>;
  hot_refreshed: boolean;
  report: { ok: boolean; exit_code: number; summary: string };
}

export interface ConfigResponse {
  provider: string;
  model: string;
  authhub_base_url: string;
  route_alias: string | null;
  has_api_key: boolean;
  // Phase 6 additions -- strictly additive/optional: the legacy shape above
  // (returned by an older server build, or asserted verbatim by pre-Phase-6
  // tests' mocked fetch responses) omits these entirely rather than sending
  // them as `null`, so every reader must treat them as possibly `undefined`.
  local?: boolean;
  redaction_enabled?: boolean;
  ollama_base_url?: string;
  ollama_model?: string;
  embeddings_backend?: string;
  // GraphRAG extraction pipeline bugfix (DEFECT 1) addition -- strictly
  // additive/optional, same shape as the Phase 6 fields above.
  auto_build_graph?: boolean;
  // Browser-audit item 4 additions -- strictly additive/optional: the
  // ACTUALLY-active provider/model, accounting for `local: true`'s
  // unconditional override of `provider`/`model` above (which stay
  // untouched by that override). Callers displaying "what model will this
  // call actually use" (e.g. AskView's model hint) should prefer these over
  // the raw `provider`/`model` fields when present.
  effective_provider?: string;
  effective_model?: string;
}

export interface ConfigUpdateRequest {
  provider?: string;
  model?: string;
  route_alias?: string | null;
  // Phase 6 additions -- strictly additive/optional.
  local?: boolean;
  redaction_enabled?: boolean;
  ollama_base_url?: string;
  ollama_model?: string;
  // GraphRAG extraction pipeline bugfix (DEFECT 1) addition.
  auto_build_graph?: boolean;
}

export interface GraphJobStatus {
  id: string | null;
  status: "queued" | "running" | "done" | "idle";
  done: boolean;
  created_at: number | null;
  updated_at: number | null;
  text_units_added: number;
  text_units_updated: number;
  text_units_deleted: number;
  entities_upserted: number;
  entities_deleted: number;
  relationships_upserted: number;
  claims_upserted: number;
  llm_calls: number;
  error: string | null;
}

export interface ModelsResponse {
  models: string[];
  current: string;
  provider: string;
  error?: string;
}

/** Same fetch-with-timeout shape as the legacy SPA's `fetchJsonWithTimeout`. */
export async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 20000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPages(): Promise<PageListItem[]> {
  const res = await fetchJsonWithTimeout("/api/pages");
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  const data = await res.json();
  return data.pages || [];
}

export async function fetchPage(path: string): Promise<PageDetail> {
  const res = await fetch(`/api/page?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`page not found: ${path}`);
  return res.json();
}

export async function runSearch(q: string, k = 8): Promise<SearchHit[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=${k}`);
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

export async function runQuery(
  question: string,
  useLlm: boolean,
  k = 8,
  mode?: QueryMode,
): Promise<QueryResponse> {
  // `mode` is omitted from the body entirely when undefined -- required by
  // the legacy-shape contract: an OMITTED `mode` key (not merely a falsy
  // one) is what selects the exact pre-Phase-4 legacy path server-side.
  const body: Record<string, unknown> = { question, use_llm: useLlm, k };
  if (mode !== undefined) {
    body.mode = mode;
  }
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Phase 5: `mode` selects which server-side graph view to fetch (see
// `api_graph` in src/mythic_proportion/web/app.py) -- "wikilinks" (default),
// "entities" (GraphRAG semantic graph), or "both". Omitting `mode` entirely
// preserves the exact pre-Phase-5 request shape (`GET /api/graph`, no query
// string) -- load-bearing for api-legacy-parity.test.ts.
export type GraphMode = "wikilinks" | "entities" | "both";

export async function fetchGraph(mode?: GraphMode): Promise<GraphData> {
  const url = mode ? `/api/graph?mode=${encodeURIComponent(mode)}` : "/api/graph";
  const res = await fetchJsonWithTimeout(url);
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  const data = await res.json();
  return normalizeGraphResponse(data);
}

export async function uploadFiles(files: FileList | File[]): Promise<{ job_id: string; saved: string[] }> {
  const formData = new FormData();
  for (const file of Array.from(files)) formData.append("files", file, file.name);
  const res = await fetch("/api/upload", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok || !data.job_id) throw new Error(data.detail || "no job id returned");
  return data;
}

export async function enqueueIngest(): Promise<{ job_id: string }> {
  const res = await fetch("/api/ingest", { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.job_id) throw new Error(data.detail || "no job id returned");
  return data;
}

export async function fetchIngestStatus(jobId: string): Promise<IngestJobStatus> {
  const res = await fetchJsonWithTimeout(
    `/api/ingest/status?job_id=${encodeURIComponent(jobId)}`,
    {},
    10000,
  );
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  return res.json();
}

// GraphRAG extraction pipeline bugfix (DEFECT 1 -- "extraction is never
// invoked by any real entry point"): the web UI's "Build Knowledge Graph"
// action, following the exact same async-job/progress pattern as
// enqueueIngest/fetchIngestStatus above.
export async function enqueueIndexGraph(): Promise<{ job_id: string }> {
  const res = await fetch("/api/index-graph", { method: "POST" });
  const data = await res.json();
  if (!res.ok || !data.job_id) throw new Error(data.detail || "no job id returned");
  return data;
}

export async function fetchIndexGraphStatus(jobId: string): Promise<GraphJobStatus> {
  const res = await fetchJsonWithTimeout(
    `/api/index-graph/status?job_id=${encodeURIComponent(jobId)}`,
    {},
    10000,
  );
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  return res.json();
}

export async function fetchLint(): Promise<LintReport> {
  const res = await fetch("/api/lint");
  return res.json();
}

export async function fixLint(): Promise<LintFixResponse> {
  const res = await fetch("/api/lint/fix", { method: "POST" });
  return res.json();
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config");
  return res.json();
}

export async function updateConfig(update: ConfigUpdateRequest): Promise<ConfigResponse> {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || res.statusText);
  }
  return res.json();
}

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch("/api/models");
  return res.json();
}
