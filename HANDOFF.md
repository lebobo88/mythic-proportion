# HANDOFF — mythic-proportion 3D GraphRAG Second Brain

This file replaces all previous revisions of `HANDOFF.md` in full. Do not
merge it with, or defer to, any earlier copy of this file you may have seen
before (an earlier revision directed the next session to continue on branch
`feat/3d-graphrag` at "Phase 7"; that instruction was already superseded once
and is now fully retired by this document).

## 1. What this is

A local LLM-Wiki "second brain" grown into a full GraphRAG-parity memory
engine: an auto-ingesting drop folder, a GraphRAG-backed knowledge graph with
hierarchical Leiden community detection, a 3D WebGL knowledge graph with four
switchable representations, a ground-up OKLCH design system, a local privacy
layer, and hardened local-only web security. An agent layer, an MCP server,
and a broader ComfyUI product asset pipeline remain deferred, unbuilt
non-goals (see Section 6).

- **Governing plans** (both in the orchestrator control repository,
  `H:\CommandCenter\orchestrator\docs\plans\`, one level up from this repo):
  1. `mythic-proportion-audit-fix-design.md` — Status APPROVED, **complete and
     closed out**.
  2. `mythic-proportion-3d-visual-enhancement.md` — Status APPROVED,
     **Phase 0 and Phase 1 complete, Phases 2–7 not yet started**.
- These two plan documents are the source of truth for scope, phase status,
  and approvals. Where anything below and either plan document disagree, the
  plan documents govern.
- Reference specs: `specs/mythic-proportion-3d-graphrag.html`,
  `specs/ROADMAP-BRIEF.md`, `docs/frontend.md`, `docs/architecture.md`,
  `docs/usage.md`.

## 2. Repository state

- **Branch**: `main`. Working tree clean, up to date with `origin/main`.
- **Latest commit**: `1a5d5e7` — "Complete 3D knowledge-graph app rebuild and
  begin visual enhancement pass" (168 files changed, 14,395 insertions, 528
  deletions).
- **Pushed**: confirmed pushed to `origin/main`; push succeeded and the
  branch is up to date with the remote.
- `origin/feat/3d-graphrag` still exists as a remote branch (an artifact of
  the earlier merge history). It is not the working branch; `main` is the
  single source of truth for all further work.
- **No commit, push, deployment, or pull request is authorized** beyond what
  has already happened, without a separate, explicit, later user approval.
  Both governing plans state this explicitly.

## 3. Plan 1 — audit, fix, and four-mode design expansion (COMPLETE)

`docs/plans/mythic-proportion-audit-fix-design.md`, approved by
rob.hasselbach@gmail.com on 2026-07-16 (with a separate token-family
approval on 2026-07-17). Fully executed and closed out. Delivered:

- **Merge and source of truth**: `feat/3d-graphrag` merged into `main` as
  the single working branch.
- **Security hardening**: a CORS allowlist scoped to known local origins
  (no wildcard); CSRF origin/referer checks on every state-changing
  `/api/*` POST route (`/api/upload`, `/api/ingest`, `/api/index-graph`,
  `/api/lint/fix`, `/api/config`); a 50MB upload cap on `/api/upload`
  enforced by streaming byte-count, not only a post-parse check.
- **Enriched `/api/graph` data contract**: a projection of already-computed
  server-side hierarchical Leiden output (`community`, `level`,
  `centrality`, optional `parentCommunity`) onto entity nodes, backward
  compatible with the client's existing approximate-grouping fallback; a
  provenance-gated fix so page and entity nodes only merge in `mode=both`
  when both title match and real extraction provenance connects them.
- **Four switchable 3D graph modes**: Cloud (original force-directed view),
  Orbital Systems, Strata, and Knowledge Terrain, all sharing one
  single-draw-call `InstancedMesh2` node layer (only the worker's force
  configuration and a bounded transition blend differ per mode). A
  mode-switch radiogroup control; bounded (~800ms), interruptible
  transitions; full per-mode 2D-fallback and accessibility-tree parity.
- **Graph state lifecycle fix**: `GraphView` now renders mounted-hidden
  rather than conditionally mounted, so tab excursions (including the
  "Open in Wiki" round trip) never cold-restart the physics worker or lose
  selection/filter/expansion state.
- **TabNav accessibility fix**: replaced a non-conformant ARIA tab-role
  hybrid with a conformant nav-plus-links pattern (`aria-current="page"`
  plus a non-color underline/bold cue).
- **Generative OKLCH community color system** with a WCAG contrast gate,
  which caught and fixed a real pre-existing contrast bug in the original
  color ramp.
- **Overall-app UX upgrade**: first-class reading/detail panes in Wiki,
  Search, Ask, and Graph; a Cmd+K command palette with grouped sections,
  full keyboard navigation, and defined empty/no-results states;
  app-wide focus-context-dim treatment.
- **Terrain chrome-layer visual assets**: two HDRI skyboxes, two matcap
  textures, two Trellis2 landmark GLBs, generated via a documented
  ComfyUI-direct-REST-API pipeline (`web/public/terrain/ASSET_MANIFEST.json`).
  All are placeholder-labeled, enhancement-only, and load through a
  non-throwing fallback path — Terrain mode is fully functional with none
  of them present.
- **Extensive bug-fixing**, most notably a multi-round 3D camera-fit
  investigation: at the start of this work the graph rendering was
  fundamentally broken (invisible nodes, incorrect camera framing at scale,
  a node-identity duplication bug, a hemisphere sign bug in the camera
  math). Root-causing this required two escalations to an Opus advisory
  plus a Fable-model engineering pass before it was fully resolved and
  confirmed via repeated live browser testing.
- **Documentation refresh**: root `README.md` and `docs/architecture.md` /
  `docs/usage.md` / `docs/frontend.md` were brought current with the merged
  application. The stale-HANDOFF problem that existed at the very start of
  this plan (an earlier `HANDOFF.md` wrongly directing continuation on the
  old feature branch) was corrected once during this plan, and is now fully
  superseded again by this document.

**Baselines at close of Plan 1**: 419 Python tests and 413 frontend tests,
all passing.

## 4. Plan 2 — Deep-Field Observatory 3D visual enhancement (IN PROGRESS)

`docs/plans/mythic-proportion-3d-visual-enhancement.md`, approved by
rob.hasselbach@gmail.com on 2026-07-18, including two explicit
approval-gated decisions:

- **Decision A (Section 5.9)** — the community-centroid glyph/badge layer —
  **APPROVED**; implemented in Phase 2.
- **Decision B (Section 5.9)** — adding `@react-three/postprocessing` as a
  new runtime dependency — **APPROVED** (exact R3F-v8-compatible v2.x
  version to be confirmed by engineering at Phase 4 implementation time;
  the approval does not pin a version number); implemented in Phase 4.

### 4.1 Why this plan exists

Triggered by a Codex `VISUAL_REVIEW` judge checkpoint after Plan 1 closed
out, which found five real issues: Orbital and Strata modes not visually
reading their intended metaphor; small/hard-to-read labels; community color
hard to distinguish in 3D at small sizes; light-theme Terrain contrast
problems; light-theme Wiki/Search low-contrast text. The user asked for a
genuine visual-quality leap rather than isolated patches. This went through
a full Studio design process — three creative directions presented
(safe/refined/novel) — and the user selected **"Deep-Field Observatory"
(refined)**: ACES tone mapping, per-mode HDRI/environment lighting via the
existing ComfyUI pipeline, selective bloom on focus/selection (gated so the
core node rendering stays a single draw call), edges upgraded to properly
render weight data (width/opacity), a shader technique giving community
identity visibility even at tiny pixel sizes in 3D, the approved
community-centroid glyph/badge layer, and a structural fix for the
light-theme Terrain contrast problem — all built strictly on top of the
existing architecture (single-draw-call instanced rendering, worker-owned
physics, the camera-fit/LOD machinery from Plan 1) without re-architecting
it.

### 4.2 Phase status

The plan is sequenced as eight phases (Phase 0 through Phase 7) in its
Section 6:

| Phase | Description | Status |
|---|---|---|
| 0 | Readiness and baseline | **Complete** |
| 1 | Foundation, tokens, F5 contrast fixes, extended contrast gate | **Complete** |
| 2 | Node material, community identity, and labels | **Not started** |
| 3 | Edges and weight readout | **Not started** |
| 4 | Post-processing chain and safe tier (adds `@react-three/postprocessing`) | **Not started** |
| 5 | Per-mode chrome and 2D/a11y parity | **Not started** |
| 6 | Chrome-layer assets (HDRI/normal/matcap/landmark generation) | **Not started** |
| 7 | Closeout | **Not started** |

Phase 0 and Phase 1 are independently Verifier-confirmed. Phase 0 established
green test baselines and confirmed the frontend build serves `/app`. Phase 1
delivered:

- ACES tone mapping live at the R3F `Canvas` level.
- Every new design token family from the plan's Section 5.2 declared, in
  both light and dark theme: environment/IBL, per-mode fog, bloom, edge-weight,
  node-material (fresnel/emissive/outline), pattern-id, two-tier labels, and
  per-mode chrome families for all four modes.
- The specific light-theme contrast bugs from the `VISUAL_REVIEW` findings
  fixed at the token level (Wiki sidebar meta text against `--color-bg-inset`,
  Search result card meta text, the light-theme search-result `mark`
  element).
- The contrast test suite extended to cover every new token pairing in both
  themes, confirmed passing, alongside the pre-existing 8/16/32 community-ramp
  contrast gate.

**Two labeled limitations from Phase 1**, carried forward as open items for
this plan's closeout, not defects:

1. "True-disabled" state tokens were declared in Phase 1 but currently have
   nothing to attach to — no current UI actually has a disabled state. This
   needs a product decision before this plan's closeout.
2. The graph node outline color cannot mathematically satisfy contrast
   against both the background AND every node fill/community color
   simultaneously, in either theme (proven by direct calculation during
   Phase 1). It is tuned to the functionally more important pairing —
   against the node fill — instead.

### 4.3 What Phases 2–7 will do

Per the plan's Section 6:

- **Phase 2** (dependency: Phase 1) — the `onBeforeCompile` fresnel-rim and
  per-instance emissive patch on the node material (single draw call,
  `colorsTexture`, never `vertexColors`); a second small data texture
  carrying a luminance-modulating pattern-id for community identity at
  small pixel sizes; the approved community-centroid glyph/badge layer
  (Decision A); the two-tier label system (community titles winning the
  ~40-label cap, node labels carrying a screen-space minimum size).
- **Phase 3** (may run in parallel with Phase 2) — a single fat-line
  (Line2/LineMaterial) edge pass with weight-driven width and opacity; a
  reading-pane Connections list with numeric edge weight plus an
  accessibility-tree Weight column; a `"weight: n/a"` fallback for missing
  weight.
- **Phase 4** (dependency: Phases 2 and 3) — half-resolution,
  emissive-driven, token-thresholded selective bloom plus vignette via
  `@react-three/postprocessing` (Decision B); bloom suppression composed
  off the existing mode-transition `transitioning` signal; a
  `PerformanceMonitor`-driven safe-tier degradation ladder; a user-facing
  effects/quality control (Auto/Full/Balanced/Minimal). This phase carries
  a hard **early-exit criterion**: a reproducible post-processing
  performance benchmark at 10,000 nodes must run on the target RTX 3080 Ti
  host across all four modes and all three effects tiers before Phase 5
  begins. At least one non-Minimal tier must meet the interactive
  performance target (p50 ≥ 30 FPS, p95 ≤ ~50ms) at 10k for post-processing
  to proceed as scoped; if only the Minimal tier meets the target, that
  result must be surfaced back to the user as a decision (cap the node
  ceiling or drop post-processing) rather than silently accepted.
- **Phase 5** (dependency: Phases 1–4) — the four per-mode "atmosphere"
  treatments: Cloud nebula haze; Orbital ecliptic disc/rings/core glow;
  Strata graded floor planes and an etched labeled axis; Terrain hillshade,
  contours, theme-paired sky, and the structural light-theme
  darkened-elements fix — each with matching 2D-fallback chrome and
  accessibility-tree parity.
- **Phase 6** (dependency: Phase 5; enhancement-only, never blocking) — the
  chrome-layer asset generation pass via ComfyUI REST plus Trellis2: a
  refreshed dark HDRI, a new light-theme high-key HDRI (none exists today),
  a terrain detail/hillshade normal map, and optionally refreshed matcaps
  or additional landmark GLBs toward the existing 6-GLB cap.
- **Phase 7** (dependency: Phases 0–6) — closeout: full green
  pytest/vitest/`make check`; the extended contrast gate green in both
  themes; an independent Verifier pass; a Browser Validator pass covering
  both the prior-machinery re-confirmation gate and the new visual
  acceptance gate, across all viewports, both themes, reduced motion, and
  forced-colors; applicable Codex judge checkpoints; a refreshed
  `ASSET_MANIFEST.json`; and a documentation refresh (this is when
  `README.md` and the frontend docs should next be updated to reflect the
  visual-enhancement work). No commit, push, deployment, or pull request
  without a separate, explicit, later user approval.

**Engineering routing for this plan**: `t2-engineer` (Sonnet) is the sole
engineering writer for every phase; T1 is not used (per the plan's Section
14/16 routing).

## 5. Current test and build baselines

Directly re-confirmed against the live working tree at the time of writing
this document:

- **Python**: `python -m pytest --collect-only -q` collects **419 tests**
  (unchanged from Plan 1's close).
- **Frontend**: `cd web && npx vitest run` — **430 tests across 43 files,
  all passing** (up from 413 at Plan 1's close; +17 new tests from Plan 2's
  Phase 1 contrast-gate extension).

One operational note for a future session: on one of two consecutive local
runs, `vitest run` reported 3 failures / 2 errors, all originating from
`src/routes/graph/__tests__/forceLayoutModes.test.ts` with a jsdom
`postMessage`/Worker-mocking error (`SyntaxError: Failed to execute
'postMessage' ... Invalid target origin '[object ArrayBuffer]'`). An
immediate re-run of the identical command was fully green (430/430, 43/43
files). This reads as jsdom/Worker-mock environment flakiness on this
particular run, not a reproduced code defect, but it was not exhaustively
investigated as part of writing this document — a future session should
re-run once if it sees a similar isolated failure in that file before
treating it as a regression.

`README.md`'s own "Development" section currently states 419 pytest / 380
vitest as its baseline; that count predates Plan 2's Phase 1 work and is now
stale by 50 tests. Refreshing it is in scope for Plan 2's Phase 7 closeout
documentation pass, not before.

## 6. Deferred non-goals (unchanged, not scheduled)

Confirmed still true by direct repository inspection: `agents/__init__.py`
and `mcp/__init__.py` remain one-line stubs; there is no `mythic mcp` CLI
verb; there is no `tools/` ComfyUI directory for a standing product
pipeline; the legacy `/` single-page app and `web/static/` remain
intentionally preserved, with no retirement scheduled. None of these are
scheduled by either governing plan. Any of them requires its own planning
pass through the orchestrator's Planner, producing a fresh approved plan,
before any implementation begins.

## 7. How to run it today

Verified directly against the current `README.md` and `pyproject.toml`:

```bash
# From the mythic-proportion/ directory:
python -m pip install -e ".[dev]"

# Initialize a vault:
mythic init ./my-vault

# A working LLM provider is required for compile/query. Default is AuthHub
# (AUTHHUB_API_KEY); Anthropic (ANTHROPIC_API_KEY, MYTHIC_LLM_PROVIDER=anthropic)
# and a local Ollama provider (MYTHIC_LLM_PROVIDER=ollama) are both selectable
# alternatives. See README.md's "LLM provider configuration" section.

# Ingest a document:
cp some-report.pdf ./my-vault/drop/
mythic ingest ./my-vault

# Build the knowledge graph (hierarchical Leiden communities, entities,
# relationships, claims) so the Graph view has real data:
mythic index-graph --vault ./my-vault

# Ask a question:
mythic query "what did that report say?" --vault ./my-vault

# Health-check the vault:
mythic lint ./my-vault

# Optional: watch drop/ in real time (requires: pip install 'mythic-proportion[watch]'):
mythic watch ./my-vault

# Web UI (requires: pip install 'mythic-proportion[web]'). The React
# frontend at /app is NOT committed to the repo -- build it once per
# checkout before serving, or /app returns 404:
cd web && npm install && npm run build && cd ..
mythic serve --vault ./my-vault   # defaults to 127.0.0.1:8765
```

- `/app` serves the current React + React-Three-Fiber frontend (built
  above). `/` serves the original vanilla-JS single-page app, preserved
  unchanged for parity.
- For live frontend development against the Graph view specifically, the
  Vite dev server (`cd web && npm run dev`, reaching a URL near
  `http://localhost:5173/app/` — confirm the exact printed port) supports
  the dev-only `?syntheticGraph=N` query parameter to exercise the graph
  with synthetic data without a live backend.
- Test and lint commands: `python -m pytest -q --cov=mythic_proportion`,
  `python -m ruff check .`, `python -m mypy src`, `cd web && npx vitest
  run`, `cd web && npm run build`, or `make check` for ruff + mypy + pytest
  together.
- Full command, configuration, and security reference: root `README.md`,
  `docs/usage.md`, `docs/architecture.md`, `docs/frontend.md`.

## 8. What a future session should do next

**Resume Plan 2 at Phase 2** (`docs/plans/mythic-proportion-3d-visual-enhancement.md`,
Section 6, "Phase 2 — Node material, community identity, and labels").
Phase 1's foundation (tokens, ACES tone mapping, the extended contrast gate)
is the completed prerequisite Phase 2 depends on. Concretely:

1. Re-read the full plan document, not only this summary — it carries the
   binding engineering invariants (Section 5.6), the acceptance gates
   (Section 8), and the exact per-phase scope (Section 6).
2. Route the next `ENGINEERING_JOB` to `t2-engineer`, per the plan's
   routing (Section 14/16); T1 is not used for this plan.
3. Implement Phase 2 as scoped: the fresnel/emissive node-material patch,
   the pattern-id data texture, the community-centroid glyph/badge layer
   (already user-approved as Decision A), and the two-tier label system.
   Take explicit care against the documented `vertexColors` black-multiply
   bug when patching the node material (Section 3.3/5.6 item 1 of the
   plan).
4. Phase 3 (edges and weight readout) may run in parallel with Phase 2,
   since both depend only on Phase 1.
5. Do not begin Phase 4's post-processing work without first confirming
   Phase 4's early-exit performance benchmark criterion (Section 6, Section
   8.2 item 8 of the plan) — it is a hard gate on the target RTX 3080 Ti
   hardware, not an assumption.
6. No commit, push, deployment, or pull request is authorized for any of
   this work without a separate, explicit, later user approval, per both
   governing plans.

Do **not** resume any older "continue at Phase 7" or "push
`feat/3d-graphrag`" instruction; that instruction was already retired
during Plan 1 and no longer applies to any file, including this one.

## 9. Historical build narrative (for context, pre-dates both governing plans)

The application's original P0–P6 build (dual-repo Vite/R3F plus FastAPI
scaffold, the OKLCH design system, the seven React views, the GraphRAG data
layer, community detection and retrieval, the original 3D graph frontend,
and the local privacy layer) was completed before either governing plan
existed, using a different execution harness (FABLE-HARNESS) than the one
now in use for this repository (the Claude Code Orchestrator's Planner /
T2-engineer / Verifier / Browser Validator pipeline). That original harness
and its execution pattern are historical background only and are not the
operative process for any further work on this repository. A post-P6
GraphRAG extraction bug-fix pass (2026-07-12) is documented in
`docs/security/security-advisory-graphrag-extraction-20260712.md` and
`docs/faq-graphrag-extraction-fixes.md`. Both governing plans in Sections 3
and 4 above supersede this historical narrative for all current scope,
status, and next-step decisions.
