# mythic-proportion — Expansion & Redesign: Grounding Brief for `/plan-deep`

> **Purpose.** This is the input brief for a `/plan-deep` (Fable-5) run that will produce the
> planf3 HTML roadmap + implementation plan at `mythic-proportion/specs/mythic-proportion-3d-graphrag.html`.
> It captures the as-is codebase, the blueprint gap, the user's locked directional decisions, hard
> constraints, and the (in-progress) grounding research. **Fable's job:** deep-synthesize this into a
> phased, testable roadmap — not to re-derive the decisions already made below.
>
> Generated 2026-07-11 by an Opus grounding pass (Hydra/pp/smith OFF; FABLE-HARNESS primitives only).

---

## 0. Source documents

- **Blueprint under assessment:** `mythic-proportion/LLM Wiki Second Brain with 3D Interactive Knowledge Graph  Technical Architecture Blueprint.md` (448 lines, 37 refs).
- **Existing deep plan (prior build):** `mythic-proportion/specs/mythic-proportion.html`.
- **Project memory:** `~/.claude/projects/H--FABLE-HARNESS/memory/mythic-proportion-project.md` (stack + hard constraints).

## 1. As-is codebase map (built, 102 tests green, verifier: pass)

Python 3.12 package `src/mythic_proportion/`, Karpathy "LLM-Wiki" pattern (LLM compiles/maintains a Markdown wiki; `[[wikilinks]]` ARE the graph). Modules:

- `vault/` — `init`, `layout`, `lint` (orphans, dangling links, thin pages, stale index).
- `ingest/` — drop-folder pipeline: `router`, `docling_adapter`, `markitdown_adapter`, `dedup`, `pipeline`, `models`. Zero-dep text fast-path + optional `[ingest]` (Docling).
- `compile/` — LLM compile of raw→wiki: `client`, `prompt`, `writer`, `graph`, `models`, `pipeline`.
- `index/` — `schema.sql`, `store` (SQLite `IndexStore`), `embeddings` (HashEmbedder default / FastEmbed optional), `retrieve` (hybrid BM25+vector).
- `query/` — `engine` (`answer_query`), `client`, `prompt`.
- `llm/` — `authhub` (OpenAI-compatible gateway client). Provider layer, prompted strict-JSON.
- `watch/` — `watcher` (optional `[watch]`, watchdog daemon).
- `web/` — FastAPI `app` + background `jobs` (ingest worker) + `pages`/`render` + **vanilla-JS SPA** in `static/` (`index.html`, `app.js` 839 LOC, `styles.css` 431 LOC).
- `cli/app.py` — **6 verbs**: `init / ingest / query / lint / watch / serve`.

**Current DB schema** (`index/schema.sql`): `pages`, `pages_fts` (FTS5 porter/unicode61), `page_vectors` (blob; sqlite-vec `vec0` created dynamically), `meta`. **No** entities/relationships/text-units/claims/communities tables.

**Current graph** (`web/app.py::api_graph` + `compile/graph.py`): nodes = pages, edges = resolved `[[wikilinks]]`. Rendered 2D on a `<canvas>` in `app.js`. Legend types: source/entity/concept/session.

**Current web routes:** `/api/pages`, `/api/page`, `/api/search`, `/api/query`, `/api/graph`, `/api/ingest(+status)`, `/api/upload`, `/api/lint(+fix)`, `/api/config`, `/api/models`. UI tabs: Wiki · Search · Ask · Graph · Ingest · Lint · Settings.

**Current LLM/embeddings:** provider `authhub` (default) → `deepseek-chat`, or `anthropic`. Structured output via **prompted strict-JSON** (AuthHub exposes no `tools`/`response_format`). Key via `AUTHHUB_API_KEY`. Embeddings: `embeddings_backend="local"`; `HashEmbedder` (offline hashing, dim 64) default, `FastEmbedEmbedder` optional. A working LLM is now **required** (no-LLM degradation was removed 2026-07-11).

## 2. Blueprint → current gap (what the plan must close)

| Dimension | Current | Blueprint target | Delta / plan work |
|---|---|---|---|
| Frontend | FastAPI + vanilla-JS SPA | Next.js + R3F + design system | New Vite+React+R3F frontend + full design system |
| Graph view | 2D canvas over wikilinks | 3D WebGL, instanced/LOD/worker, ~5k–50k nodes | New rendering engine |
| Knowledge model | pages/fts/vectors only | entities·relationships·text-units·claims·communities·community-reports | New GraphRAG tables + extraction |
| Retrieval | hybrid BM25+vector | + Leiden communities, global/local/DRIFT, spreading-activation | Retrieval deepening |
| Agents | single compile + query | Extractor / Refiner / Librarian | New agent layer (LangGraph) |
| Interop | CLI + local web | MCP server (memory substrate) | New MCP server (product feature) |
| Privacy/LLM | cloud AuthHub→DeepSeek; hash/fastembed | (open) | Local PII pre-filter + real local embeddings + optional local LLM |

**No conflict on the store:** the blueprint's own roadmap endorses **SQLite-first** (Neo4j = later/optional). Matches the locked "files-first + SQLite; Kùzu dead" decision. Neo4j stays OUT.

## 3. Locked directional decisions (from user, 2026-07-11)

1. **Frontend stack** = **Vite + React + React Three Fiber**, built to static assets and served by the existing FastAPI `mythic serve` (one process, one `pip install`, Python core unchanged).
2. **Knowledge-model depth** = **FULL Microsoft-GraphRAG parity** — entities, relationships, text units, **claims**, communities (Leiden, hierarchical), **community reports**, and **global / local / DRIFT** query modes + **query-aware spreading-activation** traversal. On **SQLite** (sqlite-vec + FTS5).
3. **Optional workstreams = ALL FOUR:**
   - **Local privacy layer** — PII redaction *before* cloud LLM calls; upgrade default embeddings to a real local model; optional fully-local small-LLM provider (Ollama).
   - **LangGraph** orchestration for Extractor/Refiner/Librarian (scoped/evaluated during planning; likely an optional `[agents]` extra).
   - **MCP server** — expose the brain as memory for external coding agents (a *product* feature of mythic-proportion; does **not** violate harness N8, which governs the harness's own operation, not what this app ships).
   - **ComfyUI** (`H:\LocalAI`) — local generation of design + graph-visual assets.
4. **Delivery = FULL GREENFIELD to the target architecture** (user, revised 2026-07-11) — clean-slate rebuild to the *course-corrected* target, **NOT** a revert to the blueprint's literal Next.js/Qdrant/Neo4j stack; decisions §3.1–§3.3 and the §7 course-corrections **still stand**. Includes **full migration of the existing vault + SQLite index** across. Highest-fidelity end-state, highest risk/longest — so the plan **must** include an explicit **data-migration + behavior-parity checklist** phase so nothing the current 102-test app does is silently lost, plus a repository-scaffold phase (the blueprint's `packages/`-style layout adapted to our Python-core + Vite-frontend reality).
5. **Graph-scale target = ~50k nodes @ 60fps (aggressive)** (user, 2026-07-11). Design in **points-as-nodes + aggressive edge culling + LOD tiers + worker-frozen layout + GPU picking from day one** — not retrofitted. `@three.ez/instanced-mesh` (BVH cull/raycast/LOD) is the front-runner render layer.
6. **Git = TWO separate PUBLIC repos** (user, 2026-07-11): `git init` **both** `mythic-proportion/` **and** `H:\FABLE-HARNESS` as independent repos; commit + push **each to its own `main` separately**; the FABLE-HARNESS repo **references/links mythic-proportion as a sibling repo** (README link + FABLE-HARNESS `.gitignore` excludes `mythic-proportion/` so the trees don't nest — submodule optional). Greenfield work still happens on a **feature branch** off mythic-proportion's `main`, merged at parity. ⚠️ Neither is a git repo yet → **Phase 0**. NOTE: creating public remotes + pushing is an **outward/publishing** action; the engineer performs it in Phase 0 under this standing authorization, **confirming remote host/names first**.

## 4. Hard constraints (must hold across every phase)

- **Build with FABLE-HARNESS primitives only** — typed `engineer` writes code, `verifier` confirms, `designer`/`design-system-curator` for UX, `browser-validator` + live Chrome each phase. **No Hydra, no pair-programmer, no smith/eights.**
- **Fable-5 = planning only (N2).** Never the build.
- **Keep the Python core importable without optional extras** — every heavy dep stays a lazily-imported optional extra (the existing `[ingest]`/`[watch]`/`[web]`/`[authhub]` discipline). New extras likely: `[graphrag]`, `[agents]`, `[privacy]`, `[embeddings]`, `[mcp]`.
- **Every web route stays a thin wrapper over the same building blocks the CLI uses** (the existing no-drift invariant in `web/app.py`).
- **Prompted strict-JSON** remains the structured-output mechanism (no assumption of native tool-calling).
- **Chrome validation every phase** (user's explicit requirement).
- **Local-first / privacy:** wherever feasible, keep personal-note content on-machine; cloud LLM calls go through the PII pre-filter.

## 5. Open questions for Fable to resolve / surface (Questionables)

- ~~Delivery~~ → **RESOLVED: full greenfield** (§3.4). ~~Node-count~~ → **RESOLVED: ~50k aggressive** (§3.5).
- Greenfield cutover: since there's no side-by-side, define the **parity gate** — the explicit checklist of current-app behaviors (all 6 CLI verbs, every web route, lint rules, ingest fast-path) the rebuild must satisfy before the old tree is retired.
- LangGraph: confirm **skip-for-core + optional PydanticAI `[agents]`** (research §6.4) vs. any reason to reconsider.
- Local LLM: is the fully-offline Ollama path a first-class provider at launch or a stretch phase?
- MCP server: confirm **read-only default + opt-in writes, stdio-first** (§6.4).
- **Data migration:** one-shot re-compile/re-index of the existing vault (+ `tmpvault`/`tmpvault2`?) into the new GraphRAG tables — backfill design + a verification that retrieval quality ≥ the current app.
- Repo layout for greenfield: adapt the blueprint's `apps/ + packages/` split to our single-Python-package + `web/` (Vite) reality — one package with sub-modules, or a genuine multi-package layout?

---

## 6. Grounding research (folded in from parallel discovery agents)

_Status: six research threads dispatched 2026-07-11 on Sonnet/Opus tiers (privacy+local-LLM · GraphRAG-on-SQLite · 3D-rendering-at-scale · LangGraph+MCP · ComfyUI-automation · design-system). Findings appended below as they land._

### 6.1 Local privacy layer + embeddings + local LLM  ✅

- **OpenAI Privacy Filter is real and locally usable** (Apache-2.0, ~Apr 2026): open-weight token-classifier, 1.5B total / 50M active params, 128K ctx, CPU/laptop-capable, `opf` CLI + HF `transformers` `pipeline("token-classification","openai/privacy-filter")`. Masks 8 PII categories (person/email/phone/address/url/date/account/secret), ~96–97% F1. Detects/masks only — pulls in `torch`. Repos: [GitHub](https://github.com/openai/privacy-filter) · [HF](https://huggingface.co/openai/privacy-filter). (Announcement page 403'd; date/F1 corroborated via secondary coverage.)
- **Recommended redaction design:** use **Microsoft Presidio** (MIT, fully local) as the framework — Analyzer + **Anonymizer with reversible de-anonymization** (exactly the redact→send→**rehydrate** flow we need) — and wire the **OpenAI Privacy Filter as a custom Presidio recognizer** (or run standalone to avoid Presidio's footprint). GLiNER-PII is an alternative recognizer; `gpt-oss-safeguard` is content-safety, **not** PII → not it.
- **Embeddings:** **stay on `BAAI/bge-small-en-v1.5`** (fastembed default, 384-dim, ONNX-quantized, best quality/MB for short chunks; cheap in sqlite-vec). Move to `nomic-embed-text-v1.5` (768-dim, 8K ctx) only for long unchunked notes. Keep `HashEmbedder` as zero-dep fallback.
- **Optional fully-local LLM:** **Ollama** exposes an OpenAI-compatible endpoint at `localhost:11434` → drops in beside the AuthHub provider via base-url/model swap. Recommend **Qwen2.5-7B-Instruct** (~4.7GB Q4_K_M, trained for structured output); pair with **Ollama structured-outputs (`format`=JSON Schema)** so malformed JSON is mechanically impossible. Design: a per-vault **`local: true`** flag routes to Ollama and **never touches the cloud**.
- **Layered flow:** redact (Presidio + OpenAI-filter) → cloud DeepSeek *or* local Qwen → rehydrate PII → embed locally (bge-small) into sqlite-vec.
- **New extras implied:** `[privacy]` (presidio/torch), `[embeddings]` (fastembed), `[local]` (ollama client — likely just httpx).

### 6.2 GraphRAG parity on SQLite (schema, Leiden, query modes, incremental)  ✅

- **Hand-roll the orchestration, borrow only MS prompts.** The `graphrag` pip package (DataShaper/pandas/Parquet) fights files-first+SQLite. Borrow verbatim MIT prompt text (`extract_graph`, `summarize_descriptions`, `extract_claims`, `community_report`) incl. the **delimited-tuple output format** + **"gleaning"** recall loop; everything else (chunk, dedup/merge, Leiden call, reports, embed) is <400 LOC over the existing provider layer. Dataflow = TextUnits → Graph Extraction(+summarize dup descriptions) → Claims → Leiden augmentation → Community reports → Embeddings.
- **Leiden:** **`graspologic.hierarchical_leiden`** (gives the leveled `.level/.cluster/.parent_cluster` hierarchy global-search needs, from a weighted `(src,tgt,weight)` edge-list — no networkx). Pin `random_seed` for stable community IDs across re-index. Windows: chunky (numpy/scipy/gensim/POT, wheels exist); **`leidenalg`+igraph** is the lighter fallback if install bites.
- **Query modes on SQLite:** GLOBAL = map-reduce over `community_reports` (optionally sqlite-vec-prefilter by query sim); LOCAL = sqlite-vec seed entities → **recursive-CTE** neighbor expand → pull `text_units`/`claims`/reports → token-budget rank; DRIFT = primer(vec over reports)→per-follow-up LOCAL loop→aggregate; **spreading-activation** = weighted scored BFS (recursive CTE × `relationship.weight` × decay, threshold), seeds from FTS5(BM25) ∪ sqlite-vec.
- **Concrete schema (coexists with pages/pages_fts/page_vectors):** tables `entities(UNIQUE(title,type))`, `relationships(source_id,target_id,type,weight)` +src/tgt indices, `text_units(page_id,chunk_index,text,content_hash)`, `text_unit_entities`, `claims`, `communities(level,cluster,parent_cluster,entity_id)`, `community_reports(UNIQUE(level,cluster))`; sibling `vec0` virtual tables `entity_vectors`/`report_vectors`/`text_unit_vectors` (match existing dim). `text_units.page_id` ties graph → wiki provenance.
- **Incremental/idempotent:** `content_hash` per text_unit (only changed chunks re-extract); an **`llm_cache(cache_key PK, response)`** keyed on `sha256(prompt||model)` (biggest cost saver + idempotency); ref-count entity provenance via `text_unit_entities` on delete; **recompute whole Leiden+reports each run** (cheap at low-thousands; MS does the same), cache reports by community content-hash.
- **Prompted strict-JSON:** prefer GraphRAG's `("entity"<|>NAME<|>TYPE<|>DESC)##(...)<|COMPLETE|>` delimited tuples over nested JSON (far more drift-robust, trivial `split` parse); if JSON, single top-level object + gleaning + low temp + balanced-brace scan + one repair round-trip + skip-chunk-not-abort; normalize titles (dedup depends on it); constrain `type` to a small enum; keep chunks small (truncated JSON = #1 failure).
- **New extra implied:** `[graphrag]` (graspologic).

### 6.3 3D graph rendering at scale (library, perf budget, R3F+Vite)  ✅

- **Library:** use **`r3f-forcegraph`** for the force sim + data/link plumbing (R3F keeps the loop via `tickFrame()` in `useFrame`) — but **do NOT use its per-node mesh path** (one mesh/node won't scale). Read tick positions and drive **your own `InstancedMesh`**; consider **`@three.ez/instanced-mesh` (InstancedMesh2)** for per-instance BVH frustum-culling + fast BVH raycast + LOD. Avoid standalone `3d-force-graph` (owns its own renderer, fights R3F).
- **Perf budget for ~10k @ 60fps mid-GPU:** nodes = **1 draw call** (InstancedMesh; points/quads even cheaper); edges = **one batched `LineSegments`**, fade distant/non-focused to ~0 alpha, cull by degree at overview; labels = **only hovered/selected/high-degree** (troika SDF atlas), never 10k DOM/`Html`; **picking = GPU pick buffer on throttled pointer events**, never per-frame raycast; **layout in a Web Worker**, `warmupTicks`→freeze on `onEngineStop`, re-heat only on data change/drag. 50k feasible with points-as-nodes + aggressive edge culling.
- **R3F/Vite:** **never `setState` in `useFrame`** — mutate matrices/uniforms via refs; React state holds only discrete UI (selected node, filters). three.js **doesn't tree-shake well** (~150KB+ gz) → lazy-load the graph route, import only used drei (`OrbitControls`, `Html` for the few labels, `PerformanceMonitor`+`AdaptiveDpr`, `Bvh`; `r3f-perf` dev-only). **Design tokens module** (community color ramp, edge alpha, degree→radius, easings) feeds uniforms/instance attributes — nothing hardcodes color.
- **Professional look:** degree-scaled nodes; **hover → raise node+1-hop neighbors+edges to full opacity, fade rest to ~0.1** (the key "premium" interaction); translucent community convex-hulls (low alpha, few); eased camera focus (~400–600ms damped lerp); ortho-overview→perspective-focus; progressive disclosure (start 20–50 nodes, expand on demand) beats any render trick for the hairball.
- **2D fallback + a11y:** keep a **2D mode** (`react-force-graph` 2D) as low-end/battery/accessible path; `<canvas>` is opaque to AT → ship a **parallel hidden semantic DOM** (keyboard-navigable node/neighbor tree + links data-table) mirroring the graph, with announced selection.

### 6.4 LangGraph fit + MCP server design  ✅

- **LangGraph — SKIP for core.** The Extractor→Refiner→Librarian pipeline is mostly linear prompted-JSON over a local store — the ~90% case where a graph engine is overhead; dep weight + provider lock-in conflict with the lean AuthHub→DeepSeek layer, and we **already have checkpointing** via files+SQLite. If typed-I/O ergonomics are wanted, adopt **PydanticAI** as an optional **`[agents]`** extra (typed outputs, usage/token-limit guards, composes into LangGraph later). **No LangChain needed.** Only reach for a thin optional LangGraph extra if a *durable long-running* Refiner loop later needs interrupt/resume (2-node `StateGraph` + `SqliteSaver` + `interrupt()` gate — a superset of the hand-rolled loop).
- **MCP server (product feature):** **FastMCP** (now in the official `mcp` SDK) — `@mcp.tool` decorator derives schema from signature/docstring. Reads: `search_graph`, `get_context_bundle(entity_id, depth)`, `search_text_units`; writes: `upsert_entity`, `add_text_unit` (transactional). **Transport: stdio primary** (Claude Code spawns it; `claude mcp add --transport stdio mythic -- python -m mythic_proportion.mcp --scope project` → committable `.mcp.json`); streamable-HTTP optional for remote.
- **MCP security:** **`--read-only` default**, writes behind explicit `--read-write`; **schema-as-defense** (enums not free strings, branded IDs, URL allow-lists); one SQLite transaction per mutation; lower rate/fan-out ceilings on writes than reads; **JSONL audit log** (tool, args-hash, ts, outcome) beside files-first state; OAuth only if HTTP is exposed (moot for local stdio).
- **New extras implied:** `[agents]` (pydantic-ai, optional), `[mcp]` (fastmcp).

### 6.5 ComfyUI headless automation for design/graph assets  ✅

- **Driving it:** built-in HTTP/WS server at `http://127.0.0.1:8188` (always the API; "headless" = launch `python main.py` and never open the canvas). Endpoints: **POST `/prompt`** (API-format graph + `client_id`), `/history/{id}`, `/view?filename=…&type=output`, `/upload/image`, `/object_info` (node schema), **`/ws?clientId=`** (progress; `executing` with `node:null` = done). **Must** submit the **"Save (API Format)"** JSON (Dev-mode), *not* the UI export.
- **Assets:** SDXL (fast icon/texture batches) or Flux (typography/adherence). Transparent PNGs via **LayerDiffuse** (true alpha) or **rembg** (post-removal); seamless textures via **ComfyUI-seamless-tiling**; drive one checkpoint + fixed style prompt/LoRA, vary subject only, for design-system consistency.
- **3D:** **ComfyUI-3D-Pack** (TripoSR/StableFast3D/InstantMesh/CRM) or **Hunyuan3D 2.x** → image→mesh in seconds–minutes, exports **glb/obj** usable in three.js/R3F via `GLTFLoader`. Honest: **prop/reference quality only** (imperfect topology/UVs), thorny CUDA deps (often a separate conda env). For graph nodes, procedural three.js geometry usually beats generated meshes → treat 3D-gen as an optional reference track.
- **Integration:** optional **localhost-only** `tools/comfy_gen.py` (~80 LOC, stdlib `urllib` + `websocket-client`): load API-format template with `{{PLACEHOLDER}}` slots → substitute → POST `/prompt` → await `/ws` → pull `/view` → save into `design-assets/<category>/`. **No-ops if the server is unreachable** (stays consistent with the no-network posture).
- **To verify the H:\LocalAI install (I can't read that path):** look for `ComfyUI_windows_portable\ComfyUI\` (`main.py`, `models\checkpoints\`, `custom_nodes\`, `output\`) + `run_nvidia_gpu.bat`; probe `GET /system_stats` (VRAM/device) and `GET /object_info` (installed nodes: layerdiffuse, seamless-tiling, rembg, 3D-Pack/Hunyuan3D) before assuming any workflow runs.

### 6.6 Design system + UX for a knowledge/graph tool  ✅

- **Token architecture:** three tiers — *primitives* → *semantic* (`--color-text-primary`) → *component*. **CSS custom properties are the single runtime source of truth** (Tailwind v4 `@theme` direction), not a JS config. **Define colors in OKLCH** (perceptually even lightness — critical so node/community colors stay distinguishable and equal-weight on a dark scene). Scales: 4px spacing base, modular type scale, `--radius-*`, named `--shadow-*` elevation. Theme via semantic overrides on `:root`/`[data-theme]`, dark-first but ship both.
- **Tokens drive the 3D scene too:** define a dedicated **`--graph-*` family** (`--graph-node-<type>`, `--graph-edge`, `--graph-edge-active`, `--graph-community-1..N`, `--graph-hull-fill`, `--graph-glow`). At runtime read them via `getComputedStyle(...).getPropertyValue('--graph-…')` → `THREE.Color`, re-read on theme change → 2D chrome and 3D scene are provably one palette. Communities map to a categorical OKLCH ramp generated once.
- **Components:** **shadcn/ui** (copies source into the repo → full ownership, no version churn; Base UI or Radix primitives for accessible/keyboard/ARIA-correct headless behavior). Avoid heavyweight kits (MUI) — right call for a small team wanting control.
- **UX patterns to adopt:** **Cmd+K command palette as the primary nav spine** across all six tabs (jump-to-node, run Ask, open Ingest) — a fuzzy combobox that bypasses the IA hierarchy; keyboard-first everything (Obsidian ethos); power tucked into panels/context menus, bias to defaults over configurability (Tana lesson).
- **Anti-hairball (load-bearing):** *never render the raw graph* — derive a **20–50-node task-focused view**, expand on interaction; local-neighborhood/degree-of-interest focus (select → 1–2 hops, fade rest); filters by type/tag/time/community; **betweenness-centrality sizing** to surface hubs; community hulls to collapse density. **2D wiki ↔ 3D graph = side-panel-plus-graph split** (graph = spatial navigator, docked reading pane = selected page; in-article links refocus the graph; linked-selection overview+detail).
- **A11y (dark + graph):** contrast 4.5:1 body / 3:1 large+UI (dark mode is *not* accessible by default — OKLCH makes ratios tractable); never encode meaning by color alone (pair with shape/icon/label); keyboard-navigable focusable nodes; honor `prefers-reduced-motion` (disable auto-rotate/force-settle, no >3 flashes/s); **mandatory non-WebGL fallback** (DOM/SVG 2D graph or structured outline of the same neighborhood).
- **Motion tokens (token-ready, Material-3/Carbon-grounded):** durations `instant 100ms / fast 150ms / base 200–250ms / slow 300–400ms`; easings `--ease-standard cubic-bezier(0.2,0,0,1)`, `--ease-out cubic-bezier(0,0,0.2,1)`, `--ease-emphasized cubic-bezier(0.05,0.7,0.1,1)` (camera/focus). **Duration scales with distance/size** (full graph re-focus animates longer than a hover); motion carries meaning (hover=neighborhood highlight, selection=camera ease-to-node, expansion=staggered fade-in); always gate behind reduced-motion.

---

## 7. Research-informed course-corrections vs. the blueprint (for Fable to weigh)

The blueprint is directionally sound but predates some of these findings; the plan should **diverge** from it on:

1. **Frontend:** Next.js → **Vite + React + R3F served by FastAPI** (locked). The blueprint's Next.js recommendation adds a second runtime with no benefit for a single-user local app.
2. **3D lib:** blueprint says `3d-force-graph`/`three-forcegraph`; research says **`r3f-forcegraph` for layout + your own `InstancedMesh` render layer** (the blueprint's picks fight R3F / won't scale nodes).
3. **Vector store:** blueprint floats Qdrant/FAISS/LanceDB; **stay on `sqlite-vec`** (already built, zero-service, matches files-first). No external vector DB.
4. **Graph store:** blueprint's Neo4j "advanced phase" is **OUT** (SQLite recursive-CTE graph is sufficient at personal scale; Kùzu dead).
5. **Agent framework:** blueprint name-drops LangChain/LangGraph; research says **skip LangGraph for core**, optional **PydanticAI `[agents]`** extra only, custom orchestrator stays.
6. **MCP:** blueprint frames it as central; keep it a **product feature, read-only by default**, stdio-first — not a core dependency of the wiki itself.
7. **New:** blueprint has no privacy story — **add the local PII pre-filter + local-embeddings + optional Ollama** workstream (user-requested, strong fit for personal notes).

## 8. Likely phase shape — GREENFIELD (a starting point for Fable — not prescriptive)

- **P0 — Dual-repo + greenfield scaffold:** `git init` **both** repos (`mythic-proportion/` and `H:\FABLE-HARNESS`), initial commit + push each to its own **public `main`**, FABLE-HARNESS `.gitignore` excludes `mythic-proportion/` + README sibling link; **confirm remote host/names before pushing** (outward action). Then scaffold the greenfield target layout (Python core sub-packages + Vite/R3F `web/` toolchain served by FastAPI) on a `feat/3d-graphrag` branch. Freeze the **parity checklist** (every current CLI verb + web route + lint rule + ingest fast-path) as the acceptance contract. *(Chrome: scaffold serves.)*
- **P1 — Design-system foundation:** OKLCH three-tier tokens + `--graph-*` family, shadcn/ui components, Cmd+K palette spine, light/dark theme, motion tokens. *(Chrome: token/theme/palette validation.)*
- **P2 — Core rebuild + data migration:** re-establish ingest/compile/index/query on the clean structure; **one-shot migrate the existing vault + SQLite index**; prove parity vs. the frozen checklist (retrieval quality ≥ current). *(Chrome: every legacy route/verb works on the new tree.)*
- **P3 — GraphRAG data layer:** new SQLite tables + entity/relationship/claim extraction via prompted delimited-tuples + `llm_cache` + incremental re-index. *(Chrome: graph API returns rich semantic nodes.)*
- **P4 — Communities + retrieval modes:** graspologic hierarchical Leiden + community reports + global/local/DRIFT + spreading-activation. *(Chrome: Ask tab drives the new modes.)*
- **P5 — 3D graph frontend (50k target):** r3f-forcegraph layout + **own InstancedMesh2 (points/LOD/BVH-cull/GPU-pick) from day one** + worker-frozen layout + batched edges w/ culling + hover/focus/hulls + filters + Cmd+K jump + 2D fallback + a11y shadow-DOM. *(Chrome: perf @ ~50k + interaction validation.)*
- **P6 — Privacy layer:** Presidio + OpenAI-filter redact/rehydrate, bge-small local embeddings default, optional Ollama `local:true` provider. *(Chrome: Settings toggles; redaction round-trip.)*
- **P7 — Agent layer:** Extractor/Refiner/Librarian (custom orchestrator; optional PydanticAI `[agents]`). *(Chrome: Refiner maintenance surfaced in UI.)*
- **P8 — MCP server:** FastMCP stdio, read tools + opt-in writes + transactional + JSONL audit. *(Validate via `claude mcp add`.)*
- **P9 (optional) — ComfyUI asset pipeline:** localhost `tools/comfy_gen.py` for design/graph textures + plan diagrams.
- **P10 — Cutover:** retire the legacy tree only after the parity checklist + all Chrome validations pass; merge `feat/3d-graphrag` → `main`; push.

Each phase = FABLE-HARNESS `engineer` builds → tests → `verifier` confirms → **live Chrome validation** → commit on branch. Reflexion ×1, escalate at 3 loops. Optional extras stay lazily-imported (`[graphrag]`/`[agents]`/`[privacy]`/`[embeddings]`/`[local]`/`[mcp]`).
