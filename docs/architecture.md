# Architecture

Mythic Proportion implements Andrej Karpathy's **LLM-Wiki** pattern: instead
of stateless RAG that re-discovers everything from raw chunks on every query,
an LLM *incrementally compiles and maintains* a persistent wiki of Markdown
pages that *accumulates* knowledge and cross-references over time. Knowledge
**compounds** rather than being rediscovered.

## The three layers

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

`mythic serve` boots a local FastAPI app (`web/app.py`'s `create_app`) that
serves a vanilla-JS single-page app (`web/static/`) over six tabs (Wiki,
Search, Ask, Graph, Ingest, Lint) plus a small JSON API
(`/api/pages`, `/api/page`, `/api/search`, `/api/query`, `/api/graph`,
`/api/ingest`, `/api/upload`, `/api/lint`, `/api/lint/fix`). Every route is a
thin wrapper around the exact same building blocks the CLI already uses —
`ingest_drop`, `compile_source`, `IndexStore`/`hybrid_search`,
`answer_query`, `lint_vault`/`lint_fix` — so the web UI can never drift from
CLI behavior; it is a second entry point onto Layers 1–3, not a parallel
implementation. `fastapi`/`uvicorn` (the optional `web` extra) are imported
lazily inside `create_app` (and inside the CLI's `serve` command body), so
the rest of the package — including the other five CLI verbs — stays
importable without them.

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
