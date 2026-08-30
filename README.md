# Mythic Proportion

An **LLM-Wiki second brain** with an auto-ingesting drop folder, a
GraphRAG-backed knowledge graph, and a 3D interactive graph viewer. Drop any
document, image, or artifact into `vault/drop/`; the system parses it,
preserves the immutable original in `vault/raw/`, and compiles it into a
persistent, self-linking, Obsidian-compatible Markdown knowledge graph —
searchable via a local SQLite hybrid-search sidecar, optionally kept live
with a real-time watcher, and explorable through a React/Three.js web app at
`/app` with four switchable 3D/2D graph representations.

See `specs/mythic-proportion.html` and
`specs/mythic-proportion-3d-graphrag.html` for the full implementation plans,
and `docs/architecture.md` / `docs/usage.md` / `docs/frontend.md` /
`docs/obsidian.md` for the deeper docs. The core LLM-Wiki pipeline (project
scaffold, ingestion, LLM compile, hybrid index, query & lint, the optional
watcher, and the web UI) plus the GraphRAG data layer, community detection,
retrieval modes, the 3D graph frontend, and a local privacy layer are all
complete and merged to `main`. An agent layer, an MCP server, a broader
ComfyUI asset pipeline, and retirement of the legacy `/` single-page app
remain deferred, unbuilt future work (see "What's not built yet" below).

## 60-second quickstart

```bash
# From the mythic-proportion/ directory:
python -m pip install -e ".[dev]"

# Initialize a vault (creates drop/, raw/, wiki/{sources,entities,concepts,sessions}/,
# .index/, .vault-meta/, _templates/, schema.md, index.md, hot.md, and a
# ready-to-open .obsidian/ config with graph colour groups + templates):
mythic init ./my-vault

# A working LLM provider is required for compile/query (see "LLM provider
# configuration" below) -- set AUTHHUB_API_KEY (default provider, AuthHub),
# ANTHROPIC_API_KEY (MYTHIC_LLM_PROVIDER=anthropic), or point at a local
# Ollama model (MYTHIC_LLM_PROVIDER=ollama) first.

# Drop something in, then ingest it (parses, dedups, files it in raw/, and
# compiles it into wiki pages via the configured LLM provider):
cp some-report.pdf ./my-vault/drop/
mythic ingest ./my-vault

# Build the knowledge graph (hierarchical Leiden communities, entities,
# relationships, claims) so the Graph view has real data to show:
mythic index-graph --vault ./my-vault

# Ask a question (synthesized + cited via the configured LLM provider):
mythic query "what did that report say?" --vault ./my-vault

# Health-check the vault (orphans, broken links, stale index rows):
mythic lint ./my-vault

# Optional: watch drop/ in real time instead of running `ingest` by hand
# (requires: pip install 'mythic-proportion[watch]'):
mythic watch ./my-vault

# Optional: run the local web UI (requires: pip install 'mythic-proportion[web]').
# One command builds the frontend if needed and serves ./my-vault:
./scripts/prod.sh    # Git Bash; or  .\scripts\prod.ps1  in PowerShell

# List all seven public commands (plus two hidden utility commands):
mythic --help
```

Open `./my-vault` directly in Obsidian — see `docs/obsidian.md`.

## Web UI

### Launching

Two one-command launchers wrap the whole stack. They are safe to run at the
same time -- different ports, different vaults, so testing never touches your
real notes:

| | Open | Backend | Vault |
| --- | --- | --- | --- |
| `./scripts/prod.sh` | `http://127.0.0.1:8765/app/` | `:8765` | `./my-vault` |
| `./scripts/dev.sh` | `http://localhost:5173/app/` | `:8766` (proxied) | `./dev-vault` |

From PowerShell, call `.\scripts\prod.ps1` / `.\scripts\dev.ps1` directly --
the `.sh` files are thin Git Bash wrappers around them. `make prod` / `make dev`
also work if you have GNU make installed; it is not required.

- **prod** (`scripts/prod.ps1`) activates `.venv`, rebuilds the
  frontend only when it is stale, and serves your real vault. Flags:
  `-SkipBuild`, `-NoBrowser`, `-Port`, `-Vault`, `-Force` (free a busy port).
- **dev** (`scripts/dev.ps1`) creates `./dev-vault` on first run
  (seeded from `demo-vault`; `-Empty` to skip), starts the backend over it,
  and runs Vite with hot reload. Vite proxies `/api` to the dev backend (see
  `web/vite.config.ts`), so the frontend is fully live. Ctrl+C stops both
  processes, leaving no orphans. Flags: `-Force`, `-Empty`, `-Port`,
  `-ApiPort`, `-Vault`.

Under the hood, `mythic serve --vault ./my-vault` starts a local FastAPI
server at `http://127.0.0.1:8765/` by default (override with `--host`/`--port`; pass
`--no-browser` to skip auto-opening it). It serves two frontends side by
side, wrapping the exact same building blocks the CLI uses:

- **`/app`** — the current React + React-Three-Fiber frontend. Requires a
  one-time frontend build (`cd web && npm install && npm run build`, which
  writes `src/mythic_proportion/web/static_next/`); the build output is not
  committed to the repository, so run this fresh after any checkout. If the
  build hasn't been run, `/app` returns 404.
- **`/`** — the original vanilla-JS single-page app, preserved unchanged
  for parity. Retiring it is explicitly deferred, non-scheduled future work.

Requires the optional `web` extra:

```bash
pip install 'mythic-proportion[web]'
```

### Seven views

- **Wiki** — browse pages, rendered Markdown with live wikilinks.
- **Search** — hybrid BM25 + vector search over the vault.
- **Ask** — synthesized, cited question answering.
- **Graph** — the knowledge graph, in four switchable representations (see
  below).
- **Ingest** — drag-and-drop upload into `drop/`, or trigger an ingest cycle
  over files already there, plus a "Build Knowledge Graph" action that runs
  `mythic index-graph`.
- **Lint** — vault health check, with a one-click fix action.
- **Settings** — LLM provider/model/base-URL configuration, including the
  optional auto-build-graph-after-ingest toggle (off by default).

Wiki, Search, Ask, and Graph share a first-class reading/detail pane with a
consistent loading/empty/error/populated state contract across all four
views. `Cmd+K` (`Ctrl+K` on Windows/Linux, also reachable via a visible
header button) opens a command palette with grouped sections — Navigate (any
of the seven tabs), Pages (jump to a Wiki page), Graph (focus a page's node
in Graph), and Actions (Run Ask, Open Ingest) — with typed filtering,
arrow-key navigation, Enter to activate, Escape to close with focus
restored, and defined empty/no-results states. Tab navigation uses real
links with `aria-current="page"` plus a non-color underline/bold cue, while
still behaving as an in-app transition with no full page reload (a full
reload would tear down the Graph view's live worker and 3D state).

### Four graph modes

The Graph view renders the same underlying node/edge data through four
user-switchable modes, selected via a `role="radiogroup"` control:

- **Cloud** — the original force-directed "neural cloud" view (2D fallback
  unchanged).
- **Orbital Systems** — a community-shell layout grouping nodes by Leiden
  community.
- **Strata** — a Leiden-hierarchy-level layout, stacking all available
  hierarchy levels simultaneously (a deliberate simplification; there is no
  separate single-level drill-down selector).
- **Knowledge Terrain** — a heightfield surface with nodes placed by region
  and elevation.

All four modes share one single-draw-call `InstancedMesh2` node layer; only
the physics worker's force configuration and, in 3D, a bounded transition
blend differ per mode — there are no per-node meshes in any mode. Switching
modes never resets selection, filters, or expanded-node state, including
across an "Open in Wiki" round trip or any other tab excursion; each switch
is announced via an `aria-live="polite"` region. Mode transitions use a
pure, bounded (~800ms), interruptible blend between two real worker-computed
position snapshots — never a scripted animation — and resolve instantly
under `prefers-reduced-motion`. Every mode has a matching 2D fallback and
accessibility-tree view (nested community groups for Orbital, per-level
hierarchy groups with a populated links table for Strata, elevation-tier
region groups for Terrain), all driven by the same shared grouping logic and
color system as the 3D scene, so the two representations stay in agreement.

Each mode also carries ACES-tone-mapped lighting, selective bloom on
focus/selection, and a matching atmospheric "chrome" treatment — Cloud gets
a nebula haze; Orbital gets an ecliptic disc, community-shell rings, and a
core glow; Strata gets graded floor planes with edge-lit rim walls and an
etched axis; Terrain gets hillshade shading, contour lines, and a
theme-paired sky. A toolbar "Graph detail" control (Auto/Full/Balanced/
Minimal) lets these effects scale down for performance. Edges render with
weight-driven width and opacity, with the same weight value surfaced in the
reading pane's Connections list and the accessibility tree's Weight column.
Node selection clears via Escape, a close button on the reading pane, or a
click on empty canvas space, without moving the camera.

Knowledge Terrain ships optional placeholder chrome assets — a refreshed
dark-theme equirectangular HDRI/skybox image, a new light-theme high-key
HDRI (not yet the light-theme default, pending contrast confirmation),
two neutral topographic matcap textures, two low-poly landmark models,
and a terrain detail/hillshade normal map (seven assets total) — at
`web/public/terrain/` (manifest at
`web/public/terrain/ASSET_MANIFEST.json`, documenting generation
parameters for reproducibility). The dark-theme HDRI also drives
image-based lighting, theme-gated so it is never active in light theme.
Terrain mode is fully functional with none of these assets present: they
load via a non-throwing fallback path and never break the 3D scene if
missing, and they are explicitly labeled placeholder, not
production-ready.

### Enriched graph data

`GET /api/graph?mode=wikilinks|entities|both` (default `wikilinks`, the
original `[[wikilink]]` page graph, unchanged since before the GraphRAG
work). `mode=entities` returns the GraphRAG semantic graph (entity nodes,
typed and weighted relationship edges); `mode=both` returns the union, with
`kind: "page"|"entity"` on every node. Entity nodes with at least one stored
Leiden-community row gain `community` (the finest stored level's cluster
ID), `level`, `centrality` (`degree` and `eigenvector`, both normalized
0–1), and an optional `parentCommunity` (ancestor cluster IDs at coarser
levels); entities that were never Leiden-clustered get no extra keys at all,
so the client falls back to its own approximate grouping. This is a pure
projection of already-computed server-side hierarchical Leiden output — it
is not new graph computation.

In `mode=both`, a page node and an entity node merge into a single node only
when both their normalized titles match exactly **and** real extraction
provenance connects them (the page's source hash names a document the
entity was actually extracted from). Title matching alone is not
sufficient — ambiguous same-titled pairs are intentionally left as separate,
unmerged nodes.

## Security and privacy

- **CORS** is locked to a small, closed allowlist of local origins (the
  built/served frontend's default `127.0.0.1:8765`/`localhost:8765` and the
  Vite dev server's default `127.0.0.1:5173`/`localhost:5173`) — no
  wildcard.
- **CSRF** protection checks the `Origin`/`Referer` header on every
  state-changing `/api/*` POST route (`/api/upload`, `/api/ingest`,
  `/api/index-graph`, `/api/lint/fix`, `/api/config`).
- **Uploads** via `POST /api/upload` are capped at 50MB, enforced by
  streaming byte-count as the request body arrives (not only a post-parse
  check).
- **Local-mode/Ollama privacy routing**: setting `local: true` (or
  `MYTHIC_LLM_PROVIDER=ollama`) enforces loopback-only egress, checked both
  when settings are saved and when an LLM client is constructed, so a cloud
  provider can never be reached in local mode.
- PII redaction (Presidio-based, fail-closed) wraps every outbound cloud LLM
  call. See `docs/security/` (threat model, control matrix, data
  classification, SBOM) and `docs/faq-graphrag-extraction-fixes.md` for the
  full security design and incident history.

## LLM provider configuration

A working LLM provider is **required** for `ingest --compile` and `query` —
there is no offline/no-LLM mode; a missing or misconfigured provider raises
a clear, actionable error instead of silently degrading.

The default provider is **AuthHub**, an OpenAI-compatible multi-provider
gateway that mythic authenticates to with an `AUTHHUB_API_KEY` (sent as
`X-API-Key`) and requests a **DeepSeek** model by default
(`POST {base_url}/api/v1/ai/chat/completions`, structured output via
prompted strict JSON). Install it with:

```bash
pip install 'mythic-proportion[authhub]'
export AUTHHUB_API_KEY=...
```

Relevant environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MYTHIC_LLM_PROVIDER` | `authhub` | `authhub`, `anthropic`, or `ollama`. |
| `AUTHHUB_API_KEY` | — | AuthHub gateway credential (required for the `authhub` provider). |
| `MYTHIC_AUTHHUB_BASE_URL` (or `AUTHHUB_BASE_URL`) | `http://localhost:3000` | AuthHub gateway base URL. |
| `MYTHIC_LLM_MODEL` | `deepseek-chat` | Model slug sent to whichever provider is active. |
| `MYTHIC_ROUTE_ALIAS` | — | Optional AuthHub routing hint. |

**Anthropic (Claude) remains a selectable alternative provider:**

```bash
pip install 'mythic-proportion[llm]'
export MYTHIC_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=...
```

**A local Ollama provider is also available**, for fully private,
loopback-only compile/query with no cloud egress (requires the optional
`local` extra and a running local Ollama server with a pulled model, for
example `qwen2.5:7b-instruct`):

```bash
pip install 'mythic-proportion[local]'
export MYTHIC_LLM_PROVIDER=ollama
```

BM25/hybrid retrieval (`search`) and the dangling-wikilink graph stubs in
`lint` require no LLM and keep working exactly as before — it is only
`compile` (used by `ingest`/`watch`/`index-graph`) and `query`'s answer
synthesis that require a configured LLM provider. See `docs/architecture.md`
for the full design rationale.

## Development

```bash
python -m pytest -q --cov=mythic_proportion
python -m ruff check .
python -m mypy src

cd web
npx vitest run
npm run build

# or, ruff + mypy + pytest together via the Makefile:
make check
```

Current baselines: 419 pytest tests across 30 files, all passing; 881
vitest tests across 79 files, all passing; ruff and mypy clean; `tsc
--noEmit` clean; `npm run build` succeeds (one non-blocking bundle-size
advisory for a chunk over 500kB, not a build error).

## What's not built yet

The following remain explicit, deferred non-goals, not partially-built
features: an agent layer (`agents/` is a one-line stub), an MCP server
(`mcp/` is a one-line stub, no `mythic mcp` CLI verb), a broader ComfyUI
product asset pipeline beyond the Knowledge Terrain chrome-asset capture
described above, and retirement of the legacy `/` single-page app. None of
these have scheduled work in the current plan; they require a separate
planning pass before implementation begins.

## Design ethos

Seven public commands (`init` / `ingest` / `index-graph` / `query` / `lint`
/ `watch` / `serve`, plus two hidden utility commands not part of the public
surface) on the surface; a typed, robust pipeline underneath. Parsing/
filing/dedup (`ingest --no-compile`) and search stay dependency-light —
hybrid retrieval gets better with local embeddings — but compiling wiki
pages, synthesizing query answers, and extracting the GraphRAG entity graph
now require a configured LLM provider (AuthHub/DeepSeek by default,
Anthropic/Claude, or a local Ollama model): a missing credential is reported
as a clear, actionable error rather than a silent stub.
