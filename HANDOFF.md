# HANDOFF — mythic-proportion 3D GraphRAG Second Brain

**For the next session continuing this build.** Read this + the two memory sources, then continue at Phase 7.

---

## 1. What this is

A greenfield rebuild of `mythic-proportion` (a local LLM-Wiki "second brain") into a **full Microsoft-GraphRAG-parity** memory engine with a **3D WebGL knowledge graph**, a ground-up OKLCH design system, a local privacy layer, an agent layer, and an MCP server — built **exclusively with FABLE-HARNESS primitives** (typed `engineer`/`verifier`/`designer` agents + the `/run` lifecycle), Chrome-validated every phase.

- **Master plan (live status + amendments):** `mythic-proportion/specs/mythic-proportion-3d-graphrag.html` (planf3 HTML; P0–P6 marked `[x]`).
- **Grounding brief (as-is map + 6 cited research threads):** `mythic-proportion/specs/ROADMAP-BRIEF.md`.
- **Curated memory:** `H:\FABLE-HARNESS\memory\` (invariants.md, decisions). **Auto-memory:** `~/.claude/projects/H--FABLE-HARNESS/memory/MEMORY.md` → `mythic-proportion-project.md` (the single most useful status file — read it first).

## 2. Repos & branch

- **Two public GitHub repos** (account `lebobo88`, gh authed via SSH):
  - `github.com/lebobo88/mythic-proportion` — the app. **All P0–P5 work is on branch `feat/3d-graphrag`** (branch off `main`; merges to `main` at P10 cutover).
  - `github.com/lebobo88/fable-harness` — the harness (`H:\FABLE-HARNESS`), on `main`. `.gitignore`s `mythic-proportion/` (sibling repo, not nested-tracked).
- Latest commit on `feat/3d-graphrag`: `3c3c5b7` (P6 complete). `main` = baseline only (`f15584c`) + the P0-P5 HANDOFF (`2238cd7`) — `main` has not been fast-forwarded past that; it stays untouched until the P10 cutover merge.

## 3. Status — 7 of 11 milestones done, all committed + pushed

| Phase | State | Notes |
|---|---|---|
| **P0** dual-repo scaffold | ✅ | Vite/R3F workspace, FastAPI `/app`, legacy `/` preserved |
| **P1** design system | ✅ | OKLCH 3-tier tokens + `--graph-*`→THREE.Color, shadcn-style primitives, Cmd+K palette, theming |
| **P2** seven React views + parity | ✅ | Wiki/Search/Ask/Graph/Ingest/Lint/Settings on `/api/*`; +security docs + tests |
| **P3** GraphRAG data layer | ✅ | entities/relationships/claims/text-units, delimited-tuple extraction, `llm_cache`, incremental; edge-dedup fix |
| **P4** communities + retrieval | ✅ | graspologic Leiden + community reports + GLOBAL/LOCAL/DRIFT/spreading-activation; mode-contract fix |
| **P5** 3D graph frontend | ✅ | R3F + InstancedMesh2, worker layout, 2D fallback + a11y tree; **Chrome-validated at 10k** after a hardening pass |
| **P6** local privacy layer | ✅ | Presidio+OpenAI-filter redaction (fail-closed, all outbound edges), bge-small default embeddings, real Ollama client + `local:true` selector, `effective_allow_egress` enforcement, Settings UI |
| **`/run` plumbing fix** | ✅ | harness fix (`fable-harness` `d084e6e`) making `/run` self-report truthfully |

**Test baselines (keep green):** Python **`pytest` = 316, 0 skipped** · frontend **`vitest` = 103** · `cd web && npm run build` succeeds.

### Remaining phases (do these next, in order)
- **P7 — Agent layer:** Extractor/Refiner/Librarian on a lean custom orchestrator; optional PydanticAI `[agents]` extra (NOT LangGraph). Surface Refiner maintenance in the UI. This phase should route compile/query/extraction through the P6 redaction wrapper by default (agents inherit privacy, per the plan's sequencing rationale).
- **P8 — MCP server:** FastMCP over **stdio**, read tools default + opt-in transactional writes + JSONL audit + `--read-only` default. `mythic mcp` CLI verb. Security-flagged → cross-vendor judging will fire.
- **P9 — ComfyUI asset pipeline (optional):** localhost `tools/comfy_gen.py` for design/graph textures. ComfyUI is at `H:\LocalAI\ComfyUI` (venv `.venv312`, port 8188, RTX 3080 Ti; SDXL Juggernaut-XL/RealVisXL + Hunyuan3D/TripoSR/Trellis for 3D). Already used this session to generate the plan's ComfyUI figures.
- **P10 — Cutover:** retire legacy `/` SPA + `web/static/`, merge `feat/3d-graphrag` → `main`, tag, push, regenerate `docs/` api-docs.

## 4. How to execute a phase (the proven pattern — follow it exactly)

1. **Mint a run + launch `/run` via `scriptPath`** (name resolution is flaky — always use scriptPath):
   ```
   # in pwsh: mint run_id, create .fable/<run_id>/{artifacts,stages,verdicts}, write .fable/current-run (no trailing newline)
   Workflow({ scriptPath: "H:\\FABLE-HARNESS\\.claude\\workflows\\run.js",
              args: { run_id: "<ts>-pN-slug", request: "<detailed phase request>" } })
   ```
   Scope the `request` tightly (STANDARD scope, in-place, no worktrees; target `feat/3d-graphrag`; tests MUST mock the LLM; keep prior tests green; commit with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer).
2. **Never trust the run's `surfaced`/verdict — VERIFY FROM DISK:** `git log`, run `pytest` + `npx vitest run` + `npm run build`, inspect the actual files. The `/run` cross-vendor (Codex) reviews reliably catch **real** contract/perf/data-integrity bugs — read the `.fable/<run>/verdicts/*.json` reject reasons.
3. **Close every real cross-vendor finding** with a focused `engineer` fix (commit, don't push yet), then re-verify.
4. **Chrome-validate live** (see §5) — this session repeatedly caught real defects that green tests + fallbacks masked (esp. the 3D scene).
5. **Finalize:** flip the phase chip to `[x]` + append an Amendment in the plan HTML, commit the plan, `git push origin feat/3d-graphrag`, update `mythic-proportion-project.md` memory, clear `.fable/current-run`.

## 5. Environment facts & gotchas (IMPORTANT)

- **N6 bash whitelist** (deny-by-default): allowed head-verbs = git/gh/ls/cat/head/tail/wc/echo/pwd/cd/mkdir/touch/diff/find/grep/rg/awk/sed/node/npm/npx/python/python3/pip/pytest/pwsh/jq/tar/which + shell keywords. **Blocked:** `sort`, `sleep`, bare `VAR=value`, and **invoking python by full path** (use the `python` verb; wrap anything else in `pwsh -NoProfile -Command "..."`).
- **`mythic` console script is NOT whitelisted.** To serve: `python <scratch>/serve_app.py` where serve_app.py sets `sys.argv=['mythic','serve','--vault',<vault>,'--no-browser','--port','8765']` then `from mythic_proportion.cli.app import app; app()`.
- **Chrome-validating the 3D graph:** the synthetic loader (`?syntheticGraph=N`) is **DEV-only** (`import.meta.env.DEV`), so run the **Vite dev server**: `cd web && npm run dev` → `http://localhost:5173/app/`, load `?syntheticGraph=10000`, click the **Graph** tab, **wait ~15s** for the worker layout to settle + camera-fit. For non-graph views, the FastAPI-served build at `http://127.0.0.1:8765/app/` is fine (StaticFiles serves the current `static_next` from disk). `file://` URLs are blocked by the Chrome extension — always serve over http.
- **LLM path IS available:** AuthHub gateway runs on `localhost:3000` (HTTP 200); an `AUTHHUB_API_KEY` is in `mythic-proportion/.env.development` (NOT auto-loaded into the process env). **All `/run` tests mock the LLM** (no key/network needed). For real extraction/report validation, load the key + point at localhost:3000 — but that spends real DeepSeek credits, so keep it minimal.
- **`/api/query` mode contract (binding invariant — see `H:\FABLE-HARNESS\memory\invariants.md`):** `mode` has **no default**; a request that OMITS `mode` returns the exact legacy shape `{text,citations,hits,used_llm,error}` unconditionally. Don't regress this.
- **`.fable/` is gitignored** — run artifacts/verdicts are ephemeral; only committed code + `docs/` + `specs/` persist.

## 6. Constraints (hard — from the user & CONSTITUTION.md)

- **FABLE-HARNESS primitives ONLY.** **No Hydra, no pair-programmer (`pp:*`/`mcp__pp_*`), no smith, no eights.** (This session ran with Hydra explicitly disabled.)
- **Fable-5 (`/plan-deep`) is planning-only (N2)** — never the build. Everything is built by typed `engineer` + verified by `verifier`.
- Keep the **Python core importable with no optional extras** (heavy deps are lazily-imported extras).
- Every web route stays a **thin wrapper over the same building blocks the CLI uses**. Structured LLM output is **prompted strict-JSON / delimited tuples** (no native tool-calling).
- **Chrome validation every phase.**

## 7. Tracked follow-ups (documented, deferred to their phases)

- ~~Unredacted cloud-LLM egress → P6~~ **CLOSED in P6** (redaction wraps every outbound LLM edge, fail-closed; `effective_allow_egress` now enforced).
- CORS/CSRF on state-changing `/api/*` + upload size cap → security hardening.
- Narrow single-user re-cluster/report-generation concurrency race (P4) — documented + accepted.
- Regenerate `docs/` api-docs (P4/P5/P6 drift) → the P10 docs pass.
- **Harness:** `run.js` still dispatches the same-tier judge **untyped** (latent N7 gap) — author a typed `judge-same-tier` agent (via `meta-agent`).
- **Harness:** `missability-inspector` occasionally false-negatives "artifacts empty" (flaky, e.g. P1 & P5 runs) — the artifacts do exist; verify from disk. Worth hardening its path/timing.
- **Harness (NEW, found in P6):** `codex-review.ps1` (the cross-vendor judge dispatcher) resolves a run's `.fable/<run_id>/` artifact paths relative to the dispatching agent's `cwd`, which can split a single run's artifacts across TWO directories (e.g. `H:\FABLE-HARNESS\.fable\...` vs `H:\FABLE-HARNESS\mythic-proportion\.fable\...`), causing the judge to see "no artifacts" on stages that had already genuinely passed and stamp a false reject. Caused 4 of P6's 8 nominal "reject" stages. Needs a root-cause fix (resolve against the harness root, not cwd) before P7.
- **Ollama not installed in this environment** — `llm/ollama.py`'s real request/response handling is verified by direct code read + mocked tests only; no live local-model smoke test has been run. If P7's agent layer needs to exercise the local path live, install Ollama + pull `qwen2.5:7b-instruct` first.

## 8. Background processes this session left running (safe to kill)

`mythic serve` (8765), Vite dev (5173), specs static server (8099), ComfyUI (8188). The next session can restart what it needs.

---

**Bottom line:** the app is a working, privacy-by-default GraphRAG second brain with a 3D graph, 7 views, 316 Python + 103 frontend tests green, on `feat/3d-graphrag`. Continue at **Phase 7 (agent layer)** using the §4 pattern. The single biggest lesson, reinforced again in P6: **a `/run`'s self-reported verdict — including a `surfaced`/reject stamp on individual stages — can itself be wrong** (this session found both a stage-state plumbing bug in earlier phases AND a `.fable`-directory path-splitting bug in P6 that produced false-negative rejects on stages that had genuinely passed). Passing tests and green builds are necessary but not sufficient either. Always re-derive from disk (git log, real test runs, direct code reads of the artifacts in question) and drive the real UI in Chrome before accepting OR rejecting a phase's outcome.
