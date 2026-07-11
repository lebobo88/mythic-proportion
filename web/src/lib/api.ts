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
}

export interface QueryResponse {
  text: string;
  citations: string[];
  hits: SearchHit[];
  used_llm: boolean;
  error: boolean;
}

// Phase 4: query modes exposed by the Ask view's mode dropdown -- "auto"
// (default) preserves the legacy answer behavior unchanged until the graph
// layer has data (see src/mythic_proportion/query/engine.py `_resolve_mode`).
export type QueryMode = "auto" | "legacy" | "global" | "local" | "drift" | "activation";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
}

export interface ConfigUpdateRequest {
  provider?: string;
  model?: string;
  route_alias?: string | null;
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
  mode: QueryMode = "auto",
): Promise<QueryResponse> {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, use_llm: useLlm, k, mode }),
  });
  return res.json();
}

export async function fetchGraph(): Promise<GraphData> {
  const res = await fetchJsonWithTimeout("/api/graph");
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  return res.json();
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
