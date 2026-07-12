# Changelog

All notable changes to Mythic Proportion are documented here. This file is organized by phase (newest first), tracking the greenfield rebuild from Phase 0 onward.

## v0.7.0 — GraphRAG Extraction Critical Fixes (feat/3d-graphrag)

### Security Issues

**[CRITICAL] Defect #4: PII Cloud-Egress Leak in Repair/Gleaning Rounds**
- A genuine PII vulnerability exists in the GraphRAG extraction pipeline's repair and gleaning rounds. Real names, emails, phone numbers, and other PII can be sent unmasked to cloud LLM providers during multi-round extraction.
- **Who is affected by Defect #4**: Vaults with `redaction_enabled=true` (Phase 6 default) that ran extraction with repair or gleaning rounds enabled.
- **Who should re-run extraction**: All Phase 3+ vaults that have ever run extraction. Defects #2 and #3 (data quality) affect all vaults; Defect #4 (PII leak) affects only those with `redaction_enabled=true`.
- **Root cause**: Redaction/rehydration state was scoped per-LLM-call instead of per-extraction-turn, causing already-rehydrated PII to be re-embedded in repair/gleaning prompts.
- **Fix**: Redaction map now scoped to entire extraction turn. Repair/gleaning prompts operate on redacted text throughout; only final records are rehydrated once after all rounds complete. No unredacted PII exits during a turn, and no `REDACTED_*` placeholder persists in final data.
- **See**: Security advisory in docs/security/ for detailed mitigation, incident-response procedures, and provider data-retention guidance.

### Bug Fixes

**Defect #1: Extraction Command Unreachable** — `mythic index-graph` was orphaned (no UI, no watcher). Added three entry points: "Build Knowledge Graph" button in Ingest view, "Auto-build knowledge graph after ingest" toggle in Settings (OFF by default), and un-hid CLI command from `--help`.

**Defect #2: Extraction Reads Lossy Wiki Pages Instead of Raw Sources** — `reindex_graph` used compressed `wiki/` pages instead of full `raw/` documents, yielding ~50× fewer text units. Now reads raw sources directly, recovering full document content for extraction.

**Defect #3: Tuple Parser Corrupts ~89% of Entities** — LLM learned from inconsistent few-shot examples (prompt said `##` but showed `\n`). Rewrote prompts with explicit `##`-delimited examples, added parser defense-in-depth to handle both formats. Extracted descriptions now clean, no syntax leakage between records.

### No Breaking Changes

- Base install (no `privacy`, `embeddings`, `web`, or `graphrag` extras) unchanged.
- All six CLI verbs (`init`, `ingest`, `query`, `lint`, `watch`, `serve`) unaffected.
- Pytest baseline: 316 passing; Vitest: 103 passing; all new/modified tests maintain zero regressions.

### API Changes

**New endpoint**: `POST /api/index-graph` — Enqueue a GraphRAG extraction job (async, follows IngestWorker pattern).  
**New endpoint**: `GET /api/index-graph/status` — Poll the current/most-recent graph-index job.  
**Modified endpoint**: `POST /api/config` — New optional field `auto_build_graph: bool`.

---

## Phase 2 — Core rebuild + data migration (c57e641)

Seven React views rebuilt on the Phase 1 design system and served at `/app`. Legacy vanilla-JS SPA at `/` preserved for parity.

### Frontend

- **Seven React views** (`web/src/routes/`) on the Phase 1 design-system foundation:
  - `WikiView` — browse pages, rendered Markdown with live wikilinks
  - `SearchView` — hybrid BM25 + vector search results
  - `AskView` — synthesized, cited question answering
  - `GraphView` — wikilink network as 2D node/edge graph (ready for Phase 5 3D upgrade)
  - `IngestView` — drag-and-drop file upload into `drop/`
  - `LintView` — vault health check with one-click fix
  - `SettingsView` — LLM provider/model/base-URL configuration
- **Command palette** (`CommandPalette.tsx`) — Cmd+K driven navigation across all tabs, fuzzy page search, quick jump-to-node
- **Shell** (`AppShell.tsx`) — header, tab navigation, theme toggle, error boundaries
- **Build pipeline** — `vite build` compiles React → `src/mythic_proportion/web/static_next/` (mounted at `/app` by `fastapi` when present; legacy `/` unaffected)
- **Package.json** — Vite + React 18 + React Three Fiber (R3F) dependencies locked; `npm run dev` for local dev, `npm run build` for production

### Backend

- **Data migration** — one-shot re-compile and re-index of the existing vault, proving parity with the Phase 0 baseline (`parity-checklist.md`):
  - All six CLI verbs (`init`/`ingest`/`query`/`lint`/`watch`/`serve`) confirmed working on greenfield structure
  - All 11 web routes (`/api/pages`, `/api/page`, `/api/search`, `/api/query`, `/api/graph`, `/api/ingest`, `/api/upload`, `/api/lint`, `/api/config`, `/api/models`) return the expected shape
  - Hybrid BM25+vector search ranking preserved
  - Lint rules (orphans, dangling links, thin pages, stale index) enforced identically
