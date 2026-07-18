# Architecture

Mythic Proportion implements Andrej Karpathy's **LLM-Wiki** pattern: instead
of stateless RAG that re-discovers everything from raw chunks on every query,
an LLM *incrementally compiles and maintains* a persistent wiki of Markdown
pages that *accumulates* knowledge and cross-references over time. Knowledge
**compounds** rather than being rediscovered.

## The layers

The core LLM-Wiki pipeline is three layers; the web UI, GraphRAG data layer,
3D graph frontend, and privacy layer are built on top of them as Layers 4–6
below.

```
drop/ --ingest--> raw/ (Layer 1)      --compile--> wiki/ (Layer 2)   --index--> .index/ + schema/index/hot (Layer 3)
```

### Layer 1 — `raw/` (immutable inputs)

Anything dropped into `vault/drop/` is classified (`document` / `image` /
`artifact`), parsed into unified Markdown — via **Docling** (IBM, MIT —
PDF/Office/image OCR+vision) with a **MarkItDown** fast-path for simple
Office/HTML/CSV, or a zero-dependency direct-read fence for code/JSON/YAML/
text artifacts — and the original is preserved untouched under
`raw/<sha256-hash><ext>`, keyed by content hash for dedup. This layer never
requires an LLM or network access; it's the always-on foundation
(`mythic ingest --no-compile`).

### Layer 2 — `wiki/` (LLM-compiled pages)

Given a parsed source plus the current `schema.md`/`index.md`, the configured
LLM provider compiles it into 8–15 interlinked Markdown pages across four
types (`sources/`, `entities/`, `concepts/`, `sessions/`), reusing existing
pages by title (dedup), weaving `[[wikilinks]]`, and recording contradictions
rather than silently overwriting conflicting claims. **The wikilink network
*is* the knowledge graph** — no separate graph database, no proprietary
index. A working LLM provider is required: with no credential configured (or
on any client failure), `compile_source` raises
`compile.models.CompileError` with an actionable message instead of writing
a degraded stub page (see "Pluggable LLM provider layer" and "The
no-degradation decision" below).

### Layer 3 — schema + navigation + hybrid index

- `schema.md` — the page-type contract (frontmatter fields, wikilink
  convention).
- `index.md` — an append-only catalogue of every page and its backlinks
  (doubles as a change history — never rewritten, only appended).
- `hot.md` — a ~500-word recent-context cache, refreshed on every compile.
- `.index/mythic.sqlite3` — a zero-server SQLite sidecar: **FTS5** for BM25
  sparse search (stdlib SQLite, always available, no API) and **sqlite-vec**
  for cosine vector search on top of a local (or remote) embedding backend.
  Incremental: `mythic reindex` (and every `query`/`lint` call) only
  re-embeds/re-writes pages whose content hash changed since the last sync.

### Layer 4 — `web/` (the local web UI)

`mythic serve` boots a local FastAPI app (`src/mythic_proportion/web/app.py`'s
`create_app`) that serves **two frontends side by side**:

- **`/app`** — the current React + React-Three-Fiber application
  (`web/src/`), built via `cd web && npm run build` into
  `src/mythic_proportion/web/static_next/` and mounted at `/app` only if
  that directory exists (otherwise `/app` 404s). Seven views (Wiki, Search,
  Ask, Graph, Ingest, Lint, Settings); see `docs/frontend.md` for the full
  frontend architecture, the four-mode Graph view, and the Cmd+K palette.
- **`/`** — the original vanilla-JS single-page app (`web/static/`),
  preserved unchanged for parity. Retiring it is deferred, unscheduled
  future work.

Both frontends consume the same JSON API: `GET /api/pages`, `GET /api/page`,
`GET /api/search`, `POST /api/query`, `GET /api/graph`, `POST /api/ingest`,
`POST /api/upload`, `GET /api/ingest/status`, `GET /api/jobs/{id}`,
`POST /api/index-graph` plus its status route, `GET /api/lint`,
`POST /api/lint/fix`, `GET`/`POST /api/config`, `GET /api/models`. Every
route is a thin wrapper around the exact same building blocks the CLI
already uses — `ingest_drop`, `compile_source`, `IndexStore`/
`hybrid_search`, `answer_query`, `lint_vault`/`lint_fix`, and the GraphRAG
pipeline described below — so neither web frontend can drift from CLI
behavior; both are entry points onto the layers below, not parallel
implementations. `fastapi`/`uvicorn` (the optional `web` extra) are imported
lazily inside `create_app` (and inside the CLI's `serve` command body), so
the rest of the package — including the other six CLI verbs — stays
importable without them.

**Security hardening** (`src/mythic_proportion/web/app.py`): CORS is
restricted via `CORSMiddleware` to a closed allowlist of the four known
local origins (`127.0.0.1`/`localhost` on ports 8765 and 5173), with
`allow_credentials=False` and no wildcard. A `_csrf_protection` middleware
rejects any state-changing `/api/*` POST request (`/api/upload`,
`/api/ingest`, `/api/index-graph`, `/api/lint/fix`, `/api/config`) whose
`Origin`/`Referer` header does not match the allowlist; requests with
neither header (curl, non-browser local clients, `TestClient`) pass through,
since this is a browser-CSRF defense, not a general auth boundary — the app
has none, since it is a local single-user tool. A `_UploadSizeLimitMiddleware`
enforces a 50MB cap on `POST /api/upload` by counting streamed request-body
bytes as they arrive, before FastAPI's `UploadFile` parsing runs, closing a
resource-exhaustion gap that a post-parse-only check would leave open.

### Layer 5 — GraphRAG data layer and 3D graph frontend

On top of the wikilink graph, `src/mythic_proportion/graph/{extract,tuples,
chunk,claims,communities,reports,store,cache,index}.py` implements a
GraphRAG-style semantic layer: delimited-tuple entity/relationship/claim
extraction from `raw/` source documents, hierarchical Leiden community
detection (`graspologic` primary, `leidenalg` plus `igraph` as the Windows
fallback, gated behind the `[graphrag]` extra), community reports, and a
`GraphStore` over the same SQLite database. `mythic index-graph` (and the
`/api/index-graph` route, and an opt-in "auto-build after ingest" Settings
toggle, off by default) builds and refreshes this layer; it never runs
implicitly. Retrieval `query/modes.py` implements GLOBAL/LOCAL/DRIFT/
spreading-activation modes; the `/api/query` mode contract is preserved
as-is — a request that omits `mode` returns the legacy five-key
`{text, citations, hits, used_llm, error}` shape unconditionally.

`GET /api/graph?mode=wikilinks|entities|both` projects this data for the
frontend: `wikilinks` (default) is the original page graph, `entities` is
the GraphRAG semantic graph, and `both` is their union with page/entity
dedup gated on both title match and real extraction provenance (never title
alone). Entity nodes carry already-computed `community`/`level`/`centrality`
fields where a stored Leiden-community row exists; this is a projection of
already-computed server-side output, not new graph computation on the
request path.

The 3D graph frontend (`web/src/routes/graph/`) renders this data through
four switchable modes (Cloud, Orbital Systems, Strata, Knowledge Terrain)
sharing one single-draw-call `InstancedMesh2` node layer and a physics
worker; see `docs/frontend.md` for the full breakdown.

### Layer 6 — privacy layer

`src/mythic_proportion/privacy/redact.py` provides Presidio-based,
fail-closed PII redaction (plus a dependency-free `SecretScanRecognizer` and
an optional `OpenAIPrivacyFilter`) wrapping every outbound cloud LLM call,
including GraphRAG extraction's repair/gleaning rounds. `src/mythic_proportion/
llm/ollama.py` provides a local Ollama provider (default model `qwen2.5:7b-instruct`,
structured outputs) with a loopback-only egress gate enforced both when
settings are saved and when an LLM client is constructed
(`effective_allow_egress` — `local: true` always wins over any other
provider setting). See `docs/security/` for the full threat model, control
matrix, data classification, and SBOM, and `docs/faq-graphrag-extraction-fixes.md`
for the post-launch extraction and egress-gate fix history.

## Pluggable LLM provider layer

`compile` (Layer 2) and `query`'s answer synthesis both route through a
small provider abstraction — `compile.client.CompileClient` and
`query.client.AnswerClient` — with two concrete implementations selected by
`settings.llm_provider`:

- **`authhub` (default)** — `llm/authhub.py`'s `AuthHubCompileClient` /
  `AuthHubAnswerClient`. AuthHub is an OpenAI-compatible multi-provider
  gateway: mythic sends one HTTP contract
  (`POST {base_url}/api/v1/ai/chat/completions`, `X-API-Key: $AUTHHUB_API_KEY`)
  and AuthHub holds the actual backend-provider secret server-side, routing
  to a **DeepSeek** model by default (`MYTHIC_LLM_MODEL=deepseek-chat`).
  Because that endpoint has no `tools`/`tool_choice`/`response_format`
  option, structured output can't be obtained via tool-use the way the
  Anthropic clients do it; instead both AuthHub clients append a strict-JSON
  instruction to the system prompt and parse
  `choices[0].message.content` back into the same shape the Anthropic
  clients' tool inputs use (`llm/authhub.py::extract_json_object`), so the
  two providers can never drift on output shape. `httpx` (the optional
  `authhub` extra) is lazy-imported, exactly like `anthropic` is
  lazy-imported for the Anthropic clients.
- **`anthropic`** — `compile/client.py`'s `AnthropicCompileClient` /
  `query/client.py`'s `AnthropicAnswerClient`, the original direct-to-Claude
  clients (structured output via tool-use), selected by setting
  `MYTHIC_LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (the `[llm]`
  extra).

Both `compile.pipeline._build_client` and `query.engine._build_client` raise
`CompileError`/`AnswerError` with an actionable message (naming the missing
env var / extra) if the configured provider's credential is absent, or if
`llm_provider` names an unrecognized provider.

## Why LLM-Wiki over classic GraphRAG/LightRAG

GraphRAG builds community summaries at high token cost (~610k tokens where
LightRAG uses <100 for comparable corpora); LightRAG is a leaner entity/
relation index. But both are still *retrieval indices* — ephemeral structures
rebuilt/queried against raw chunks. Karpathy's LLM-Wiki instead produces
**durable, human-readable pages that compound**: the graph is the wikilinks,
not a proprietary index. Mythic Proportion borrows LightRAG's entity/relation
spirit (entity/concept pages) but layers a hybrid SQLite index on top purely
for retrieval *speed*, not as the source of truth — the source of truth is
always the plain Markdown files in `wiki/`.

## Why files-first + SQLite, not a graph database

Kùzu — the leading embedded graph database — was **archived in October 2025**
after Apple's acquisition of the project, immediately after this app's design
window. Betting durable knowledge storage on a graph DB that can be
discontinued at any time is a dead end. Markdown + `[[wikilinks]]` is
future-proof, diff-able, Obsidian-native, and fully user-owned with zero
lock-in; SQLite (stdlib FTS5 + the actively-maintained `sqlite-vec` extension)
covers fast hybrid retrieval without running a server. This is the
durability-over-cleverness call this project makes deliberately: the
knowledge itself never depends on a database engine surviving.

## Parsing and retrieval stay dependency-light; LLM compile/query do not

Layer 1 (`ingest`'s parse + file + dedup) and BM25 sparse search never
require an LLM or network access — they are the always-on foundation
(`mythic ingest --no-compile`, the Search tab/`hybrid_search`). Local vector
embeddings (`pip install 'mythic-proportion[embeddings]'`) are an optional
upgrade to search quality, layered on top of the same BM25 baseline:

| Capability   | Requires                                              | What you get                                  |
|--------------|--------------------------------------------------------|-------------------------------------------------|
| Python-only  | just this package                                       | parse + file + dedup; BM25-only search           |
| + local embeddings | `pip install 'mythic-proportion[embeddings]'`     | hybrid BM25 + vector cosine search               |

`compile` (Layer 2) and `query`'s answer synthesis, however, are **no longer
degradable** — a working LLM provider is required for both.

### The no-degradation decision (a deliberate reversal)

Earlier revisions of this project treated every LLM dependency as something
that must degrade gracefully: no API key meant `compile` wrote a single
well-formed stub page per source, and `query --no-llm` (or the automatic
fallback with no client configured) returned a deterministic ranked-pages
digest instead of a synthesized answer. That design was deliberately
reversed as part of the AuthHub migration:

- **Silent degradation hides misconfiguration.** A stub-page compile or a
  ranked-pages "answer" both *look* like successful output — nothing in the
  CLI's exit code or the web UI's response signals that the richer path was
  skipped, so a missing/rotated credential could go unnoticed indefinitely.
- **An LLM-Wiki's core value proposition is the compiled graph and the
  synthesized answer** — a stub page or an unranked list of pages isn't a
  degraded version of that value, it's a different (and much weaker)
  product. Papering over the gap with a fallback undersold what the tool is
  actually for.
- **The fix is to fail loudly and actionably instead.** `compile_source` and
  `answer_query` now raise `CompileError`/`AnswerError` naming exactly what's
  missing (the env var, the extra to install) when no provider is
  configured or the configured one fails — `ingest` still exits 0 overall
  (per-source compile errors are collected, not fatal to the batch), but the
  compile/query gap itself is never hidden.

BM25/hybrid retrieval and the dangling-wikilink graph stubs `lint` produces
were never part of the "degradation" being removed — they remain
LLM-independent, exactly as before.
