# HANDOFF — mythic-proportion 3D GraphRAG Second Brain

This file replaces all previous revisions of `HANDOFF.md` in full. Do not
merge it with, or defer to, any earlier copy of this file you may have seen
before. In particular, this revision supersedes the mid-Phase-7 revision
written earlier in this same extended session (the one that set the
phase-status table to "Phases 0–6 Complete / Phase 7 In Progress" and
described only the documentation refresh as Phase 7 work) — a great deal of
additional Phase 7 closeout work has happened since that revision, and it is
fully described below. That mid-session revision itself superseded a still
earlier one that wrongly directed continuation on branch `feat/3d-graphrag`;
neither older instruction describes the current state of this repository.

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
     closed out**, unchanged since the prior revision of this file.
  2. `mythic-proportion-3d-visual-enhancement.md` ("Deep-Field Observatory")
     — Status APPROVED. **Phases 0–6 complete; Phase 7 (closeout)
     substantially in progress, with one formal checkpoint remaining**: the
     comprehensive four-mode/both-theme `VISUAL_REVIEW` cross-vendor judge
     checkpoint that the plan's Section 12 names as "central to this plan."
     See Section 4 below for full detail.
- These two plan documents are the source of truth for scope, phase status,
  and approvals. Where anything below and either plan document disagree, the
  plan documents govern.
- Reference specs: `specs/mythic-proportion-3d-graphrag.html`,
  `specs/ROADMAP-BRIEF.md`, `docs/frontend.md`, `docs/architecture.md`,
  `docs/usage.md`.

## 2. Repository state

- **Branch**: `main`, tracking `origin/main`.
- **Working tree**: currently carries substantial **uncommitted** changes
  implementing all of Plan 2's Phases 1–6, plus the extensive Phase 7
  closeout work described in Section 4 below (regression sweep,
  documentation refresh, four-mode/both-theme visual sweep, the 10k-node
  performance re-benchmark and its GPU-degradation fix, and the full
  responsive/accessibility remediation pass). None of this work has been
  committed or pushed.
- `origin/feat/3d-graphrag` still exists as a remote branch (an artifact of
  earlier merge history). It is not the working branch; `main` is the single
  source of truth for all further work.
- **No commit, push, deployment, or pull request is authorized** for any of
  this work without a separate, explicit, later user approval. Both
  governing plans state this explicitly, and nothing in this session's
  extensive additional work changes that.

## 3. Plan 1 — audit, fix, and four-mode design expansion (COMPLETE)

`docs/plans/mythic-proportion-audit-fix-design.md`, approved by
rob.hasselbach@gmail.com. Fully executed and closed out; unchanged from the
prior revision of this file. Delivered the branch merge onto `main`, security
hardening (CORS allowlist, CSRF checks, upload cap), the enriched
`/api/graph` data contract, the four switchable 3D graph modes (Cloud,
Orbital Systems, Strata, Knowledge Terrain) sharing one single-draw-call
`InstancedMesh2` node layer, the graph state lifecycle (mounted-hidden) fix,
the TabNav accessibility fix, a generative OKLCH community color system with
a WCAG contrast gate, an overall-app UX upgrade (reading/detail panes,
command palette, focus-context-dim), Terrain chrome-layer visual assets via
ComfyUI, and a documentation refresh. Full detail is unchanged from before
and is not repeated here; see the plan document itself for the complete
record.

**Baselines at close of Plan 1**: 419 Python tests and 413 frontend tests,
all passing.

## 4. Plan 2 — Deep-Field Observatory 3D visual enhancement (PHASE 7 IN PROGRESS)

`docs/plans/mythic-proportion-3d-visual-enhancement.md`, approved by
rob.hasselbach@gmail.com, including two explicit approval-gated decisions
(Decision A, the community-centroid glyph/badge layer, implemented in Phase
2; Decision B, adding `@react-three/postprocessing` as a new runtime
dependency, implemented in Phase 4).

### 4.1 Phase status

| Phase | Description | Status |
|---|---|---|
| 0 | Readiness and baseline | **Complete** |
| 1 | Foundation, tokens, F5 contrast fixes, extended contrast gate | **Complete** |
| 2 | Node material, community identity, and labels | **Complete** |
| 3 | Edges and weight readout | **Complete** |
| 4 | Post-processing chain and safe tier (adds `@react-three/postprocessing`) | **Complete** |
| 5 | Per-mode chrome and 2D/a11y parity | **Complete** |
| 6 | Chrome-layer assets (HDRI/normal/matcap/landmark generation) | **Complete** |
| 7 | Closeout | **Substantially in progress — one formal checkpoint remaining** |

### 4.2 Phases 0–6 (brief summary — see the plan document and `docs/frontend.md` for full detail)

Phases 0–6 are complete and were independently verified across many
engineering/CODE_REVIEW/Verifier/Browser Validator cycles earlier in this
session. This section is intentionally brief; do not treat it as the primary
source on Phases 0–6 — the plan document and `docs/frontend.md` (already
current) cover it in full detail.

- **Phase 2** — node material/shader work: per-instance fresnel-rim and
  emissive patch, a pattern-id texture for community identity at small
  pixel sizes, the approved community-centroid glyph/badge layer, and the
  two-tier label system.
- **Phase 3** — edge weight readout: a batched fat-line edge pass with
  weight-driven width/opacity, plus a reading-pane Connections list and
  accessibility-tree Weight column.
- **Phase 4** — bloom/safe-tier/effects control: selective bloom and
  vignette via `@react-three/postprocessing`, a `PerformanceMonitor`-driven
  degradation ladder, and the toolbar's "Graph detail" effects/quality
  control (Auto/Full/Balanced/Minimal).
- **Phase 5** — per-mode chrome for all four modes, plus node deselection.
  This phase went through an extensive multi-round escalation: the
  camera-fit approach had to be fully reverted once after it caused real
  regressions, then rebuilt via a different, verified-safe approach; a real
  GPU memory leak causing WebGL crashes was found and fixed; a stale
  hover-state bug causing "stuck" node highlights was found and fixed.
- **Phase 6** — chrome-layer assets and image-based lighting (IBL) for the
  Terrain mode, generated via the existing ComfyUI pipeline.

### 4.3 Phase 7 (Closeout) — work completed in this extended session

The following is a complete, ordered account of Phase 7 closeout work
performed since Phases 0–6 closed. This is the most important section for a
future session to read closely before continuing.

**1. Full regression sweep.** `pytest` and `vitest` both green; `tsc`, `ruff`,
and `mypy` clean; the extended contrast gate green in both themes;
`ASSET_MANIFEST.json` confirmed byte-consistent with disk.

**2. Documentation refresh.** `README.md`, `docs/frontend.md`,
`docs/architecture.md`, and this file were brought current with the
completed Phases 1–6. (That earlier documentation pass is superseded and
extended by this current revision, not redone.)

**3. Comprehensive four-mode/both-theme visual sweep.** All 8 combinations
(Cloud/Orbital/Strata/Terrain × dark/light) confirmed rendering correctly,
with distinct per-mode chrome and correct selection/deselection behavior in
each; light-theme Terrain's node-vs-sky contrast was specifically
re-confirmed.

A false alarm surfaced and was resolved during this sweep: a
"continuous camera zoom-out" defect that looked severe on first discovery
turned out, after rigorous live instrumentation (180+ seconds of direct
measurement), to be caused by a stale/orphaned dev-server process left over
from earlier testing sessions in this same session — not a real code defect.
A clean-environment retest confirmed zero drift across all 8 combinations.

> **LESSON FOR FUTURE SESSIONS:** this project's live-testing history has
> repeatedly been confounded by accumulated stale dev-server processes across
> long sessions. Always verify a clean, single-server environment (check
> ports 5173–5185, kill orphans) before trusting an unexpected live-test
> failure, especially anything camera- or performance-related.

**4. 10,000-node performance re-benchmark.** Re-run because Phase 5/6 added
real GPU cost since Phase 4's original benchmark (Section 4.2 above; see the
plan document for that original benchmark's numbers). This re-benchmark
found a genuine, severe regression: Cloud mode at the "Full" effects/quality
tier crashed (WebGL context loss / render-thread hang) within 3–9 seconds at
10k nodes.

Root cause: the "Full" tier was implemented in a way that also **disabled**
the app's own emergency GPU-pressure safety valve — the
`PerformanceMonitor`-driven auto-degradation ladder that normally sheds
bloom, then ambient effects, then chrome, then LOD under sustained pressure.
"Full" quality therefore had no way to self-rescue and simply crashed
instead of gracefully degrading.

Fix: "Full" now respects the live degradation signal — it still starts at
full quality, but can shed load under genuine sustained pressure, the same
as "Auto." Re-tested: 5 consecutive runs across the worst-case combinations
(Cloud+Full+10k ×3, Terrain+light+Full+10k, Orbital+Full+10k) all passed
cleanly on the target RTX 3080 Ti host.

> **HONEST CAVEAT for future sessions:** in none of those 5 passing runs did
> the degradation ladder actually visibly engage — the GPU simply was not
> under enough sustained pressure to need it during retesting. So while the
> underlying design flaw (an emergency safety valve that could be disabled)
> is confirmed fixed, and is objectively correct regardless, whether this
> specific fix is what would prevent the *original* crash under genuinely
> heavier load has not been directly observed in action — only inferred from
> clean re-test results. If a 10k-node context-loss crash is ever reported
> again in Full tier specifically, revisit this.

**5. Responsive/accessibility matrix** (this plan's Section 8/10
requirement, never previously exercised in this whole project — all prior
live testing in this project's history had been done at a single ~1440
desktop viewport only):

- **~834px tablet**: clean, first attempt.
- **~375px narrow**: clean, first attempt (toolbar wraps, reading pane
  becomes a dismissible bottom sheet).
- **400% zoom / 320px reflow** (the WCAG 1.4.10 reference point): required
  four remediation cycles to fully resolve, each closing with a real,
  useful finding:
  1. Real horizontal-overflow bug — the top navigation did not reflow at
     320px. Fixed.
  2. The graph's hidden accessibility tree (`GraphA11yTree`, the *only*
     keyboard path to select individual graph nodes in the default 3D
     view) was never actually properly "visually hidden but focusable," as
     the plan's own design had always assumed. A CSS `:focus-within` rule
     was inadvertently un-hiding it destructively whenever a keyboard user
     tabbed into it, at every viewport width, crushing the reading pane at
     narrow widths specifically. The first fix attempt (making it
     permanently invisible) traded that bug for a new one: a real WCAG
     2.4.7 (Focus Visible) violation — up to ~1,500 sequential tabbable
     controls with zero visible focus indicator for sighted keyboard users.
  3. The corrected fix — a bounded, capped-height reveal on focus, with
     focus programmatically moved to the reading pane after a
     tree-driven selection — was structurally correct but had a small,
     precisely-measured 8px CSS math gap: a flex-layout `gap` spacing value
     was not included in a container-growth calculation. Caught by a live
     test.
  4. All four issues are now fixed and confirmed via a final live re-test
     with exact pixel measurements: the a11y tree now reveals as a
     properly bounded, visible-with-focus-outline box (not permanently
     invisible, not unboundedly large); the canvas/reading pane never gets
     crushed (measured 265px, versus a prior failure state of ~9px);
     selecting a node via the tree correctly moves focus to the reading
     pane, and the tree cleanly collapses back to hidden with no visual
     overlap.
- **Reduced motion** (`prefers-reduced-motion: reduce`): confirmed clean —
  mode transitions and hover/select glow are instant; auto-2D-fallback-on-
  reduced-motion confirmed working.
- **Forced colors** (Windows High Contrast Mode emulation): confirmed
  clean — DOM chrome (toolbar, reading pane, labels) remains fully legible
  and keyboard-operable; canvas color is correctly decorative-only in this
  mode.

> **NOTE — tooling.** The 320px/zoom, reduced-motion, and forced-colors
> checks required installing Playwright + Chromium (pinned version
> 1.61.0/1.61.1) into the local npm/Playwright user cache, with explicit
> user approval obtained first. This did not touch the project's own
> `package.json`, lockfile, or source — only a shared local tool cache.
>
> **NOTE — one-time external tool exception.** For the final small 8px-gap
> CSS fix specifically, the user explicitly authorized, as a one-time
> exception, consulting an external "agy" CLI tool with a Gemini 3.1 Pro
> model for a second opinion before implementing. This is **not** this
> project's standard practice — the standard/only authorized cross-vendor
> review tool for this project is the guarded local Codex CLI integration
> (`docs/JUDGE-CONTRACT.md`) — and should not be assumed available or
> repeated automatically in a future session without the same kind of
> explicit, one-time user approval.

### 4.4 What remains for Phase 7 closeout (not yet done)

**1. The comprehensive four-mode/both-theme `VISUAL_REVIEW` cross-vendor
judge checkpoint.** The governing plan explicitly deferred this specific
formal checkpoint from every earlier phase to this final closeout step (the
plan's Section 12 names it as "central to this plan"). It requires:

- (a) Fresh screenshots captured and **saved to a location inside this
  repository**, covering all 4 modes in both themes. None of the extensive
  screenshots taken during this session's live testing (Section 4.3 above)
  were saved in a way that satisfies this requirement — they went to
  temp/scratch directories outside the repository.
- (b) A judge call routed through the project's standard guarded local
  Codex CLI review process (`docs/JUDGE-CONTRACT.md`) — **not** the
  one-time "agy"/Gemini exception used for the small CSS fix in Section 4.3.

This is the one formal, plan-required gate standing between the current
state and declaring Phase 7 — and the whole Deep-Field Observatory plan —
fully closed out.

**2. After that checkpoint**, Phase 7's own closeout checklist should be
marked fully complete in this file and in the plan document's own status
line, per the plan's Section 17 approval-gate convention.

### 4.5 Behavior changes an operator/developer should know

- `web/package.json` has one new runtime dependency,
  `@react-three/postprocessing` — run `npm install` fresh after pulling this
  work.
- The Graph view has a new user-facing "Graph detail" effects/quality
  control in the toolbar (Auto/Full/Balanced/Minimal); "Full" now respects
  the live GPU-degradation signal rather than disabling it (Section 4.3
  item 4 above).
- Node selection can be cleared via Escape, a close button, or an
  empty-canvas click.
- The graph's hidden accessibility tree (`GraphA11yTree`) now reveals as a
  bounded, visible-with-focus-outline box on keyboard focus, rather than
  either staying destructively un-hidden or permanently invisible (Section
  4.3 item 5 above).
- No new dev commands or flags were introduced by this plan; the existing
  `?syntheticGraph=N` dev-only Vite query parameter remains the mechanism
  for exercising the visual layer with synthetic data at 1.5k/10k scale.

**Engineering routing for this plan**: `t2-engineer` (Sonnet) is the sole
engineering writer for every phase; T1 is not used (per the plan's Section
14/16 routing).

## 5. Current test and build baselines

The following were confirmed green during the Phase 7 regression sweep
(Section 4.3, item 1): `pytest`, `vitest`, `tsc --noEmit -p .` (strict),
`npm run build`, `ruff check .`, `mypy src`, and the extended contrast gate
(`contrast.test.ts`) in both themes. `ASSET_MANIFEST.json` was confirmed
byte-consistent with disk.

**Honest gap:** no exact, final, consolidated pass/fail counts (test
counts, file counts) for this most recent regression sweep are available to
this document beyond "all green" as stated above. The last recorded exact
counts, from the prior HANDOFF revision (sourced from the Phase 1–6
`DOCUMENTATION_HANDOFF` packet, before this session's further Phase 7 work),
were 419 Python tests across 30 files and 881 frontend tests across 79
files. Given the amount of Phase 7 work since (including new
responsive/accessibility fixes), those exact numbers should be treated as
approximate history, not a current baseline. **A future session should
re-run the full suite and record the current exact counts as part of
finishing Phase 7**, rather than relying on the numbers above.

## 6. Deferred non-goals (unchanged, not scheduled)

Confirmed still true by direct repository inspection as of the last full
check: `agents/__init__.py` and `mcp/__init__.py` remain one-line stubs;
there is no `mythic mcp` CLI verb; there is no `tools/` ComfyUI directory
for a standing product pipeline; the legacy `/` single-page app and
`web/static/` remain intentionally preserved, with no retirement scheduled.
None of these are scheduled by either governing plan. Any of them requires
its own planning pass through the orchestrator's Planner, producing a fresh
approved plan, before any implementation begins.

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
# frontend at /app is NOT committed to the repo; the launcher builds it
# when stale, so /app never 404s on a fresh checkout:
./scripts/prod.sh    # 127.0.0.1:8765 over ./my-vault
./scripts/dev.sh     # localhost:5173 (Vite HMR) + :8766 backend over ./dev-vault
# (PowerShell: .\scripts\prod.ps1 / .\scripts\dev.ps1. `make prod`/`make dev`
#  work too, but GNU make is not installed on all dev machines.)
```

- `/app` serves the current React + React-Three-Fiber frontend (built
  above). `/` serves the original vanilla-JS single-page app, preserved
  unchanged for parity.
- `./scripts/dev.sh` (`scripts/dev.ps1`) is the supported live-development path: it
  boots a backend on `:8766` over the throwaway `./dev-vault` and Vite on
  `http://localhost:5173/app/`, with `/api` proxied to that backend
  (`web/vite.config.ts`) so the frontend is fully wired, and stops both on
  Ctrl+C. The Vite port is now `strictPort`, so an occupied 5173 fails loudly
  instead of drifting to 5174+. The dev server also supports
  the dev-only `?syntheticGraph=N` query parameter to exercise the graph
  with synthetic data without a live backend. Before trusting any
  unexpected live-test result, especially anything camera- or
  performance-related, confirm a clean single-server environment first
  (check ports 5173–5185 for orphaned processes) — see the lesson recorded
  in Section 4.3 above.
- `web/package.json` gained a new runtime dependency,
  `@react-three/postprocessing`, during Plan 2's Phase 4 — a fresh
  `npm install` is required after pulling this work (the `npm install`
  step above already covers it). The Graph view's toolbar also has a
  "Graph detail" effects/quality control (Auto/Full/Balanced/Minimal).
- Test and lint commands: `python -m pytest -q --cov=mythic_proportion`,
  `python -m ruff check .`, `python -m mypy src`, `cd web && npx vitest
  run`, `cd web && npm run build`, or `make check` for ruff + mypy + pytest
  together.
- Full command, configuration, and security reference: root `README.md`,
  `docs/usage.md`, `docs/architecture.md`, `docs/frontend.md`.

## 8. What a future session should do next

**Close out Plan 2's Phase 7** — one formal checkpoint remains
(`docs/plans/mythic-proportion-3d-visual-enhancement.md`, Section 12).
Concretely:

1. Re-read the full plan document, not only this summary — it carries the
   binding engineering invariants and the exact Section 12 judge-route
   requirements.
2. Run the comprehensive four-mode/both-theme `VISUAL_REVIEW` checkpoint
   (Section 4.4 above):
   - Capture fresh screenshots covering all 4 modes in both themes and
     **save them to a location inside this repository** — do not reuse or
     rely on this session's earlier screenshots, which went to
     temp/scratch directories outside the repository.
   - Route the judge call through the project's **standard guarded local
     Codex CLI review process** (`docs/JUDGE-CONTRACT.md`) — not the
     one-time "agy"/Gemini exception used earlier in this session for an
     unrelated small CSS fix; that exception is not standing practice and
     should not be assumed available without fresh, explicit user
     approval.
   - Before doing any further live browser testing as part of this
     checkpoint, confirm a clean, single dev-server environment (check
     ports 5173–5185 for orphaned processes) — see the stale-dev-server
     lesson in Section 4.3 above.
3. Re-run the full test/build suite and record the current exact
   pass/fail counts in this file's Section 5, replacing the approximate
   historical numbers there.
4. Once the `VISUAL_REVIEW` checkpoint and its evidence are complete, mark
   Phase 7's closeout checklist complete in this file and update the plan
   document's own status line, per the plan's Section 17 approval-gate
   convention.
5. If a 10k-node WebGL context-loss crash is ever reported again in "Full"
   effects tier specifically, revisit the fix and caveat recorded in
   Section 4.3, item 4 above — the design fix is confirmed correct, but its
   effectiveness against the original crash scenario was inferred from
   clean re-test results, not directly observed engaging under load.
6. **No commit, push, deployment, or pull request is authorized** for any
   of this work without a separate, explicit, later user approval, per both
   governing plans. The working tree currently holds all of Plan 2's
   Phases 1–6 and this session's Phase 7 closeout work uncommitted (Section
   2 above).

Do **not** resume any older "continue at Phase 7" instruction from a version
of this file that predates this revision — those instructions describe an
earlier, less-complete state of Phase 7 and are superseded in full by this
document.

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
