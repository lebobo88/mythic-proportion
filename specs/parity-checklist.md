# Parity checklist — Phase 0 acceptance contract for Phase 2

This is the frozen behavior-parity contract for the greenfield rebuild (see
`specs/mythic-proportion-3d-graphrag.html`, Phase 2 — "Core rebuild + data
migration + parity gate"). Every item below must be demonstrably true of the
rebuilt tree — proven (tests, `verifier` re-derivation, live Chrome
validation), not assumed — before the legacy tree is retired (Phase 10).

Source of truth for the "current" behavior this checklist freezes:
`specs/ROADMAP-BRIEF.md` §1 (as-is codebase map, 102 tests green, verifier:
pass) plus the actual `src/mythic_proportion/` tree as of the Phase 0
baseline commit on `main`.

Status legend: `[ ]` not yet verified on the rebuilt tree · `[x]` verified.

## 1. CLI verbs (`mythic <verb>`, `src/mythic_proportion/cli/app.py`)

- [ ] `init` — creates a new vault with the expected layout (`vault/layout.py` /
      `vault/init.py` conventions: drop/, raw/, .index/, .vault-meta/, config).
- [ ] `ingest` — runs the drop-folder pipeline (router → docling/markitdown
      adapter or zero-dep text fast-path → dedup → compile → reindex) against
      files in `drop/`.
- [ ] `query` — runs `answer_query` (hybrid retrieval + LLM synthesis via the
      active provider) and prints an answer + citations.
- [ ] `lint` — runs `lint_vault` and reports orphans / dangling links / thin
      pages / stale index entries with the documented exit code.
- [ ] `watch` — starts the `watchdog`-based drop-folder daemon (optional
      `[watch]` extra) and triggers ingest on file-system events.
- [ ] `serve` — starts the FastAPI app (`web.app.create_app`) via uvicorn.

## 2. Web routes (`src/mythic_proportion/web/app.py`)

- [ ] `GET /` — legacy vanilla-JS SPA (`static/index.html`), unmodified by the
      greenfield build, still the default landing page.
- [ ] `GET /static/*` — legacy SPA static assets (`app.js`, `styles.css`)
      still served as-is.
- [ ] `GET /api/pages` — full page list with type/tags/link/backlink counts,
      sorted by title (case-insensitive).
- [ ] `GET /api/page?path=...` — single page detail: frontmatter, rendered
      HTML, raw markdown, resolved outbound links, backlinks; 404 on unknown
      path.
- [ ] `GET /api/search?q=...&k=...` — hybrid BM25 + vector search results with
      `snippet` (raw FTS5 `<mark>`) and `snippet_html` (escaped-safe) forms.
- [ ] `POST /api/query` — `{question, use_llm, k}` → answer text + citations +
      retrieval hits; never 500s (falls back to hits-only + `error: true` +
      `used_llm: false` when the LLM is unavailable).
- [ ] `GET /api/graph` — nodes (page id/title/type) + deduped, self-loop-free
      edges from resolved `[[wikilinks]]`. **Parity note (Phase 3+):** once
      the GraphRAG entity/relationship layer lands, this route gains
      semantic nodes/edges *alongside*, not instead of, this wikilink shape.
- [ ] `POST /api/ingest` — enqueues a background ingest job over `drop/`,
      returns `job_id` immediately (work happens off-request).
- [ ] `GET /api/ingest/status?job_id=...` — job status; omitted/unknown
      `job_id` returns an idle/`done: true` state rather than erroring.
- [ ] `GET /api/jobs/{job_id}` — single job detail; 404 on unknown id.
- [ ] `POST /api/upload` — saves uploaded files into `drop/` (filename path
      components stripped), enqueues ingest, returns `job_id` + saved names.
- [ ] `GET /api/lint` — same rule set as the CLI `lint` verb, JSON-shaped.
- [ ] `POST /api/lint/fix` — auto-fix pass (stub creation, index refresh),
      returns fix summary + a fresh lint report.
- [ ] `GET /api/config` — current provider/model/base-url/route-alias +
      whether an API key is present (never returns the key itself).
- [ ] `POST /api/config` — updates provider/model/route-alias at runtime, no
      restart required, applies to the next request/ingest job; rejects
      unknown providers (422) and empty model strings (422); never accepts or
      stores an API key.
- [ ] `GET /api/models` — lists models from AuthHub's model endpoint when a
      key + the `authhub` extra are present; degrades to an `error` field
      (never 500s) when the key or extra is missing, or AuthHub is
      unreachable.

## 3. Lint rules (`src/mythic_proportion/vault/lint.py`)

- [ ] Orphan pages (no inbound links) detected.
- [ ] Dangling links (`[[wikilink]]` targets with no matching page) detected.
- [ ] Thin pages (below the documented content-length threshold) detected.
- [ ] Stale index entries (index rows with no backing file, or vice versa)
      detected.
- [ ] `lint_fix` creates stubs for dangling-link targets and refreshes the
      index without silently dropping any of the above categories from the
      post-fix report.

## 4. Ingest fast-path (`src/mythic_proportion/ingest/`)

- [ ] Zero-dependency **text fast-path** (plain `.md`/`.txt`) works with no
      optional extras installed — `router.py` routes text files without
      requiring `docling`/`markitdown`.
- [ ] Optional `[ingest]` extra (`docling`, `markitdown`) adds richer
      document-format support without being required for the base path.
- [ ] Dedup (`ingest/dedup.py`) prevents re-ingesting unchanged content.

## 5. Hybrid search ranking (`src/mythic_proportion/index/`)

- [ ] `hybrid_search` combines FTS5 (BM25, porter/unicode61) lexical scoring
      with vector similarity (sqlite-vec `vec0`, dynamically created) and
      returns a single ranked hit list.
- [ ] Embeddings: `HashEmbedder` (offline, zero-dep, dim 64) remains the
      default when no local-embeddings extra is installed; `FastEmbedEmbedder`
      remains a drop-in optional upgrade (`[embeddings]`) with no ranking-code
      changes required to switch.
- [ ] `IndexStore.reindex` stays idempotent — re-running against an unchanged
      vault does not duplicate or corrupt `pages` / `pages_fts` /
      `page_vectors` rows.

## 6. Cross-cutting invariants (must hold, not just individual features)

- [ ] Every web route above remains a **thin wrapper** over the exact same
      building blocks the CLI verbs use (`ingest_drop`, `compile_source`,
      `IndexStore`/`hybrid_search`, `answer_query`, `lint_vault`/`lint_fix`) —
      no logic duplicated or forked between CLI and web.
- [ ] The Python core (`import mythic_proportion` and its non-`web`/non-`cli`
      submodules) stays importable with **no optional extras installed** —
      every heavy dependency (docling, markitdown, fastembed, anthropic,
      httpx, watchdog, fastapi/uvicorn, and the new Phase 0 extras
      `graphrag`/`privacy`/`local`/`mcp`/`agents`) is a lazy import behind its
      extra, never a base dependency.
- [ ] Structured LLM output stays **prompted strict-JSON** (or, for the new
      GraphRAG extraction prompts, delimited tuples) — no assumption of
      native tool-calling / `response_format` support, matching AuthHub's
      actual capabilities.
- [ ] The full test suite (102 tests as of the Phase 0 baseline, plus any
      tests added for migration parity) is green.
