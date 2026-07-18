# HANDOFF — mythic-proportion 3D GraphRAG Second Brain

**Correction notice.** This file previously told the next session to "continue
at Phase 7" on branch `feat/3d-graphrag` using FABLE-HARNESS primitives, and
to `git push origin feat/3d-graphrag`. That instruction is superseded and was
already flagged as contradictory by an independent plan-review finding
(`docs/plans/mythic-proportion-audit-fix-design.md`, J-001, in the
orchestrator control repository) before this correction. The reality below
reflects the actual state after that plan's Phase 3 (fix/remediation) and
Phase 4 (four-mode graph design expansion) both landed. Do not follow any
"continue at Phase 7" or "push `feat/3d-graphrag`" instruction from an older
copy of this file.

## 1. What this is

A local LLM-Wiki "second brain" grown into a full GraphRAG-parity memory
engine with a 3D WebGL knowledge graph (four switchable modes), a ground-up
OKLCH design system, a local privacy layer, and hardened local-only web
security. An agent layer and an MCP server remain deferred, unbuilt
non-goals — see Section 3 below.

- **Source of truth for scope and status**: `docs/plans/mythic-proportion-audit-fix-design.md`
  in the orchestrator control repository (`H:\CommandCenter\orchestrator`),
  approved by the user on 2026-07-16/17. That plan, not this file's older
  revisions, governs what is in scope, what is deferred, and what approvals
  are still required.
- **Master plan (live status + amendments)**: `mythic-proportion/specs/mythic-proportion-3d-graphrag.html`.
- **Grounding brief**: `mythic-proportion/specs/ROADMAP-BRIEF.md`.

## 2. Repo and branch state

- **Local `main`** is the source of truth for the current working tree. It
  contains the completed merge of `feat/3d-graphrag` (P0–P6) plus the
  subsequent Phase 3 (security/documentation remediation) and Phase 4
  (four-mode graph design expansion) work.
- **No push has occurred and none is authorized** without a separate,
  explicit, later user approval. `origin/feat/3d-graphrag` and `origin/main`
  remain at their prior state, untouched by this local work.
- **This repository's execution harness is the Claude Code Orchestrator's
  Planner → T2-engineer → Verifier → Browser Validator pipeline**, per the
  approved plan's Section 10.1 routing override (T2 as the sole engineering
  writer, no prior T1 attempt, standard gates). FABLE-HARNESS's `/run`
  lifecycle, its typed `engineer`/`verifier`/`designer` agents, and its
  execution pattern described later in this file (Section 6, historical)
  are **not** the operative harness for any further work on this repo
  going forward, unless a future plan explicitly reintroduces them.

## 3. Status — what is done and what is deferred

| Area | State | Notes |
|---|---|---|
| **P0–P6** (dual-repo scaffold, design system, seven views, GraphRAG data layer, communities + retrieval, 3D graph frontend, privacy layer) | Done, merged | See Section 6 below for the historical build narrative. |
| **GraphRAG extraction bugfixes** (post-P6) | Done | Four root-caused defects fixed; see Section 6a. |
| **Security hardening** (CORS, CSRF, upload cap) | Done | CORS restricted to a small local-origin allowlist (127.0.0.1/localhost on the app's dev and prod ports), no wildcard. CSRF origin/referer checks on all state-changing `/api/*` POST routes. A 50MB upload cap enforced by streaming byte-count, closing a resource-exhaustion gap a post-parse-only check would leave open. |
| **Documentation refresh** | Done | Root `README.md` and `docs/architecture.md`/`usage.md`/`frontend.md` now reflect the current merged state (this correction pass). |
| **Four-mode graph design expansion** | Done | Cloud (original force-directed view), Orbital Systems, Strata, Knowledge Terrain — see `docs/frontend.md` for the full breakdown. Enriched `GET /api/graph?mode=both\|entities` projects already-computed Leiden community/level/centrality data. |
| **Overall-app Standard upgrade** | Done | First-class reading/detail pane (Wiki, Search, Ask, Graph), Cmd+K command palette with grouped sections, TabNav corrected to a conformant nav-plus-links pattern, generative OKLCH community color ramp with a fixed light-theme contrast bug closed. |
| **Terrain asset capture** | Done | Placeholder chrome assets at `web/public/terrain/` (two skybox images, two matcap textures, two landmark GLBs), all enhancement-only with a working fallback; `ASSET_MANIFEST.json` documents generation parameters. |
| **P7 — agent layer** | **Deferred non-goal** | `agents/__init__.py` is still a one-line stub. Not scheduled by the current plan; requires its own planning pass before any implementation begins. |
| **P8 — MCP server** | **Deferred non-goal** | `mcp/__init__.py` is still a one-line stub; no `mythic mcp` CLI verb exists. Not scheduled. |
| **P9 — broader ComfyUI product pipeline** | **Deferred non-goal**, beyond the Terrain asset capture in this pass | No `tools/` ComfyUI directory exists for a standing product pipeline. |
| **P10 — cutover** (retire legacy `/` SPA and `web/static/`) | **Deferred non-goal** | The legacy SPA is intentionally preserved for parity; retiring it is not scheduled. |

**Test/build baselines (current, verified against the live working tree)**:
pytest 419 passed, 0 failed, across 30 test files; vitest 380 passed across
42 test files; ruff clean; mypy clean (57 source files); `tsc --noEmit`
clean; `npm run build` succeeds (one non-blocking >500kB chunk-size
advisory, not an error). Egress-gate tests (11) green in isolation. These
counts supersede any earlier baseline recorded elsewhere in this file's
history (351 pytest / 103 vitest) — the growth is almost entirely new Phase
4 test files.

**Known limitation, investigated and closed**: a rare (originally ~1-in-5)
transient rendering glitch during Orbital-to-Cloud mode transitions was
root-caused (a stale rendering-detail threshold briefly affecting real,
currently-visible nodes during the transition animation) and fixed. A
dedicated Browser Validator session ran 20 repeated Orbital→Cloud
transitions after the fix and observed the artifact zero times — a strong,
but probabilistic (not absolute), confidence result for a rare bug.

**Local environment note**: ComfyUI/Trellis2 asset generation for the
Terrain pass required two local, no-new-download environment adjustments on
this machine; both are documented in `web/public/terrain/ASSET_MANIFEST.json`
for anyone regenerating assets later.

## 4. How to run it today

```bash
pip install 'mythic-proportion[web]'   # plus [graphrag], [privacy], [local] extras as needed
cd web && npm install && npm run build  # required before /app serves; not committed to the repo
mythic serve --vault ./my-vault         # defaults to 127.0.0.1:8765
mythic index-graph --vault ./my-vault   # build/refresh the knowledge graph before Graph has real data
```

See the root `README.md` and `docs/usage.md` for the full command and
configuration reference, and `docs/frontend.md` for the frontend
architecture. To regenerate Terrain assets, ComfyUI's local REST API runs at
`H:\LocalAI\ComfyUI` (the same local GPU install used for this pass), with
full reproducible parameters in the asset manifest.

## 5. What a future session should do

Do **not** resume the old "continue at Phase 7" instruction. If the user
wants to scope P7 (agent layer), P8 (MCP server), a broader P9 asset
pipeline, or P10 (legacy-SPA cutover), that requires a new planning pass
through the orchestrator's Planner, producing a fresh approved plan — the
same governance this closeout itself followed. No engineering writer may
start work against deferred scope without that explicit approval sequence.

## 6. Historical build narrative (P0–P6, for context)

The following sections are preserved from the original build history for
context. They describe how P0–P6 were originally built using FABLE-HARNESS
primitives; that harness is no longer the operative one for this repo (see
Section 2). Environment-specific details below (bash whitelist behavior,
harness script paths, `.fable/` artifacts) are historical and may not apply
to the current execution environment.

**P0** dual-repo scaffold — Vite/R3F workspace, FastAPI `/app`, legacy `/`
preserved. **P1** design system — OKLCH 3-tier tokens, `--graph-*` →
`THREE.Color`, shadcn-style primitives, Cmd+K palette, theming. **P2** seven
React views + parity — Wiki/Search/Ask/Graph/Ingest/Lint/Settings on
`/api/*`, plus initial security docs and tests. **P3** GraphRAG data layer —
entities/relationships/claims/text-units, delimited-tuple extraction,
`llm_cache`, incremental indexing, an edge-dedup fix. **P4** communities +
retrieval — `graspologic` hierarchical Leiden, community reports,
GLOBAL/LOCAL/DRIFT/spreading-activation modes, a mode-contract fix. **P5**
3D graph frontend — R3F + `InstancedMesh2`, worker-owned layout, 2D fallback
plus an accessibility tree, Chrome-validated at 10k nodes after a hardening
pass. **P6** local privacy layer — Presidio + OpenAI-filter redaction
(fail-closed, all outbound edges), `bge-small` default embeddings, a real
Ollama client with a `local: true` selector, `effective_allow_egress`
enforcement, a Settings UI.

### 6a. GraphRAG extraction bug-fix (post-P6, 2026-07-12)

Live investigation of a real user report (ingesting real research documents
produced only topics/links with no actual detail) found four root-caused
defects in the GraphRAG extraction pipeline (`mythic index-graph`), all
fixed:

1. **Wiring gap** — `index-graph` was a fully orphaned, hidden CLI command.
   Fixed: un-hidden CLI, `POST /api/index-graph` plus status polling (live
   progress UI in the Ingest view), and an opt-in "auto-build after ingest"
   Settings toggle (off by default, since extraction spends real LLM calls).
2. **Source-of-truth gap** — extraction read `wiki/` (already-compressed
   summaries) instead of `raw/` (original documents). Fixed via
   `collect_raw_sources()`, reusing the ingest parser.
3. **Tuple parser truncation** — the extraction prompt's own worked example
   taught the model the wrong record delimiter, corrupting most entities
   with leaked tuple syntax. Fixed: corrected prompt example plus a
   balanced-paren-group fallback parser.
4. **PII cloud-egress leak (security)** — repair/gleaning rounds re-redacted
   already-rehydrated (real-PII) text from scratch each call, and Presidio
   measurably under-detects PII in tuple-formatted text. Fixed via
   turn-scoped redaction (`privacy/redact.py`'s `redact_for_turn()`/
   `complete_raw()`/`rehydrate_turn()`, orchestrated by `graph/extract.py`):
   redacted text never re-enters cleartext until the very end of an
   extraction turn.

Two further bugs surfaced only at production scale: a GPU-OOM risk in the
PII-detection transformer on large community-report prompts (fixed with a
chunked pipeline call plus offset remapping), and a rehydration
token-matching fragility that left rare literal `REDACTED_*` fragments in
entity titles — a local data-quality bug, not a further security leak, since
turn-scoped redaction already ensured nothing unmasked reached the cloud
(fixed with permissive regex-based matching, fail-open preserved).

**Docs**: `docs/security/security-advisory-graphrag-extraction-20260712.md`,
`docs/faq-graphrag-extraction-fixes.md`, `docs/CHANGELOG.md`.

### 6b. Environment facts that may still be relevant

- **Chrome-validating the 3D graph**: the synthetic loader
  (`?syntheticGraph=N`) is dev-only (`import.meta.env.DEV`), so use the Vite
  dev server (`cd web && npm run dev` → `http://localhost:5173/app/`), load
  `?syntheticGraph=10000`, open the Graph tab, and wait for the worker
  layout to settle plus camera-fit. For non-graph views, the FastAPI-served
  build at `http://127.0.0.1:8765/app/` works once `npm run build` has run.
- **`/api/query` mode contract (binding invariant)**: `mode` has no default;
  a request that omits `mode` returns the exact legacy shape
  `{text, citations, hits, used_llm, error}` unconditionally. This must not
  regress.
- **Ollama** may not be installed in every environment; `llm/ollama.py`'s
  request/response handling should be verified by direct code read and
  mocked tests if no live local-model smoke test has been run recently. If
  future work needs to exercise the local path live, install Ollama and
  pull the configured model first (default `qwen2.5:7b-instruct`).

### 6c. Superseded follow-up items

The following items from an earlier revision of this file are now closed
and are listed here only to avoid confusion if an old copy resurfaces:

- ~~CORS/CSRF on state-changing `/api/*` + upload size cap → security
  hardening~~ **Done** (Section 3 above).
- ~~Regenerate `docs/` API docs (P4/P5/P6 drift) → the P10 docs pass~~
  **Done now**, ahead of any P10 work (this correction pass); it was not
  deferred to P10 after all.
- FABLE-HARNESS-specific tooling follow-ups (a `codex-review.ps1`
  artifact-path-splitting bug, `missability-inspector` false negatives, an
  untyped same-tier judge dispatch) are specific to the FABLE-HARNESS
  execution primitives described in Section 6 and are not applicable to the
  Claude Code Orchestrator harness now in use for this repo. If
  FABLE-HARNESS is reintroduced for future work, re-verify whether those
  issues still apply before relying on it.
