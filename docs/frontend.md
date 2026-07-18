# Frontend Guide

The Mythic Proportion frontend is a **Vite + React + React Three Fiber** application built on a three-tier OKLCH design-system foundation. It is served at `/app` by the same FastAPI process that hosts the Python core, with the legacy vanilla-JS SPA at `/` preserved for parity (retiring it is deferred, unscheduled future work).

This guide reflects the merged state after the security/documentation
remediation pass and the four-mode graph design expansion. See
`docs/architecture.md` for how the frontend fits into the backend's
layered architecture (GraphRAG data layer, privacy layer) and
`docs/security/` for the CORS/CSRF/upload-cap hardening this frontend talks
to.

## Quick start

```bash
cd mythic-proportion/web
npm install
npm run dev      # Vite dev server at http://localhost:5173
```

Then from the root:

```bash
cd mythic-proportion
pip install -e ".[web]"
mythic serve --vault ./my-vault
```

This starts the FastAPI server. Navigate to `http://127.0.0.1:8765/app/` to see the new React frontend (legacy SPA at `/`).

### Production build

```bash
cd web
npm run build   # → ../src/mythic_proportion/web/static_next/
```

The build output is served automatically by FastAPI at `/app`, guarded by an `is_dir()` check (see `src/mythic_proportion/web/app.py`, the `spa_app` route).

## Architecture

### Seven views

All views consume the same `/api/*` routes the CLI uses, ensuring **no logic duplication between CLI and web**:

| View | Route | API endpoints |
|------|-------|---|
| **Wiki** | `#/wiki` (default) | `GET /api/pages`, `GET /api/page?path=...` |
| **Search** | `#/search` | `GET /api/search?q=...&k=...` |
| **Ask** | `#/ask` | `POST /api/query` |
| **Graph** | `#/graph` | `GET /api/graph?mode=wikilinks\|entities\|both` |
| **Ingest** | `#/ingest` | `POST /api/ingest`, `POST /api/upload`, `GET /api/ingest/status`, `POST /api/index-graph` + status |
| **Lint** | `#/lint` | `GET /api/lint`, `POST /api/lint/fix` |
| **Settings** | `#/settings` | `GET /api/config`, `POST /api/config`, `GET /api/models` |

Each view is a React component at `web/src/routes/{view-name}/` and is rendered by `App.tsx` based on the active tab. `GraphView` state is owned above the conditionally-rendered component (not lost on unmount), so switching away from and back to the Graph tab — including via the "Open in Wiki" action — never cold-restarts the physics worker or resets selection/filters/expanded-node state.

Wiki, Search, Ask, and Graph share a first-class reading/detail pane (`web/src/components/detail-pane/PageDetailPane.tsx`) with a consistent loading/empty/error/populated state contract across all four views.

### Design token system

A **three-tier hierarchy** ensures design consistency across the app and bridges to the 3D scene:

**Tier 1 — Primitives** (`web/src/styles/tokens/primitives.css`)
- OKLCH color scales (neutral, accent, danger, warning, success)
- 4px spacing base (e.g., `--space-1`, `--space-2`, `--space-5`)
- Modular type scale (e.g., `--font-size-sm`, `--font-size-base`, `--font-size-lg`)
- Radius tokens (e.g., `--radius-sm`, `--radius-md`)
- Shadow elevation tokens (e.g., `--shadow-sm-shape`, `--shadow-md-shape`)

**Tier 2 — Semantic** (`web/src/styles/tokens/semantic.css`)
- `--color-text-primary`, `--color-text-secondary`, `--color-text-disabled`
- `--color-bg`, `--color-bg-elevated`, `--color-bg-inset`
- `--color-border`, `--color-border-strong`
- `--color-accent`, `--color-accent-strong`, `--color-accent-muted`
- `--color-danger`, `--color-warning`, `--color-success`
- Dark is the default (`:root`); light mode overrides via `[data-theme="light"]`

**Tier 3 — Component** (`web/src/styles/tokens/components.css`)
- Button sizes, input states, dialog layering, etc. — specific to UI element anatomy

**Graph tokens** (`web/src/styles/tokens/graph.css`)
- `--graph-node-source`, `--graph-node-entity`, `--graph-node-concept`, `--graph-node-session` — node type colors
- `--graph-edge`, `--graph-edge-active` — edge rendering, plus edge-weight width/opacity minimum/maximum tokens
- A **generative OKLCH community color ramp**, `communityColor(index, count, level)` (`web/src/lib/graph-colors.ts`), computing hue as `20 + index * (360 / count)` so the ramp spreads evenly across however many real Leiden communities exist in the data rather than a fixed palette; hierarchy level maps only to a bounded chroma range, never lightness. One optional light-theme `--graph-community-*` lightness override is applied (dark-theme values unchanged) — this closes a real pre-existing WCAG contrast failure found in the original fixed 8-color ramp under the light theme.
- `--graph-community-glyph-*`/`pattern-*` tokens — non-color glyph and pattern cues that accompany every community color distinction
- `terrain.*` tokens — elevation ramp steps, contour-line tokens, sky background, matcap reference, band tokens, for the Knowledge Terrain mode
- `--focus-context-dim` — the generalized focus-plus-dim-context motif used across the graph and the overall app
- `--graph-hull-fill`, `--graph-glow` — community hull and accent effects
- Read at runtime via `getComputedStyle(...).getPropertyValue()` → `THREE.Color` for 2D/3D palette unity; `culori` is the single OKLCH-to-`THREE.Color` bridge, with no second color path and no hardcoded hex values in the ramp

All graph tokens are **additive** to the existing three-tier system; no existing token value was replaced except the flagged, approved light-theme community-lightness override above.

All tokens are **CSS custom properties** — the single runtime source of truth. Theme changes via `data-theme` are instant (no reload); the 3D scene re-reads graph tokens on every theme toggle.

### Color philosophy

- **OKLCH everywhere** — perceptually even lightness, critical for graph visualization where node/community colors must remain distinguishable and equal-weight on a dark scene
- **Dark-first** — the default; light mode is an override for accessibility and daylight use
- **Contrast audited** — WCAG 4.5:1 (body text) / 3:1 (large text + UI) in both themes (`src/styles/__tests__/contrast.test.ts`), extended to cover the generated community ramp at community counts of 8, 16, and 32, level-to-chroma bounds, and community-as-accent pairings, in both themes

### Four graph modes

The Graph view (`web/src/routes/graph/`) renders one shared node/edge dataset through four switchable modes, selected via a `role="radiogroup"` control (`GraphView.tsx` owns mode state):

- **Cloud** — the original force-directed "neural cloud" view; unchanged 2D fallback.
- **Orbital Systems** — a community-shell layout grouping nodes by Leiden community.
- **Strata** — a Leiden-hierarchy-level layout stacking all available levels simultaneously (a deliberate simplification; there is no separate single-level drill-down control).
- **Knowledge Terrain** — a heightfield surface with region/elevation-based node placement.

All four modes are worker force-configuration variants (`web/src/routes/graph/three/modeForces.ts`) layered over the same single-draw-call `InstancedMesh2` node layer (`three/InstancedNodes.tsx`) — there are no per-node meshes in any mode. `three/modeTransition.ts` implements the bounded (~800ms), interruptible transition between two real worker-computed position snapshots when switching modes; it resolves instantly under `prefers-reduced-motion`. Switching modes never touches selection, filters, or expanded-node state, and an `aria-live="polite"` region announces each change.

Each mode has a matching 2D fallback (`Graph2DModeFallback.tsx`) and accessibility-tree view (`a11y/`): Orbital as nested community-grouped clusters with a color legend, Strata as per-level hierarchy groups nesting community sub-groups plus a populated links table, Terrain as region groups labeled by elevation tier and numeric elevation value. Both the 2D fallback and the accessibility tree consume the same shared grouping logic and color system as the 3D scene.

Knowledge Terrain's optional chrome assets (`TerrainEnvironment.tsx`, `TerrainLandmarks.tsx`, `terrainAssetLoading.ts`, `terrainAssetManifest.ts`) live at `web/public/terrain/`: two equirectangular HDRI/skybox images, two neutral topographic matcap textures, and two landmark GLB models, all explicitly labeled placeholder, loaded via a non-throwing fallback path — Terrain mode is fully functional with zero of these assets present.

### TabNav and keyboard navigation

`TabNav.tsx` uses a conformant nav-plus-links pattern — real `<a>`/link elements, `aria-current="page"` on the active tab, plus a non-color underline/bold cue — while still behaving as an in-app SPA transition with no full page reload (a full reload would tear down the Graph view's live worker and 3D state).

### Cmd+K command palette

The **top-level navigation spine**. Launched via Cmd+K (Ctrl+K on Windows/Linux) or via a visible search icon in the header:

- **Navigate** — jump to any of the seven tabs.
- **Pages** — fuzzy-search and jump to a Wiki page.
- **Graph** — focus a specific page's node in the Graph view.
- **Actions** — "Run Ask", "Open Ingest", and similar quick actions.
- Typed filtering, arrow-key navigation, Enter to activate, Escape to close with focus restored to the invoking element, and defined empty/no-results states.
- **Keyboard-driven** — no mouse required; same keyboard-first ethos as Obsidian.

Implemented in `CommandPalette.tsx` using the `cmdk` library (Radix UI combobox-based). The palette is **context-aware** — pages list populated from `usePages()` hook, tabs from `TABS` config.

### Light/dark theming

Use the `useTheme()` hook in any component:

```tsx
const { theme, toggle } = useTheme();

<button onClick={toggle}>
  {theme === "dark" ? "☀️" : "🌙"}
</button>
```

The hook:
- Reads/writes `localStorage` (persisted)
- Sets `data-theme` on `<html>` root
- Triggers re-read of CSS custom properties (no page reload)
- Broadcasts theme change to the 3D scene, which re-reads graph colors from `graph-colors.ts` on every `data-theme` flip

Light mode is optimized for daylight reading; dark mode is the default and optimized for the 3D graph's dark background.

### Shell and layout

`AppShell.tsx` is the main wrapper:

```
Header (theme toggle + Cmd+K button)
├── TabNav (seven tabs)
└── Content area (active view)
```

Views receive:
- `pages` — list of all pages (from `usePages()`)
- `onSelectPage(path)` — navigate to a page (updates hash, switches to Wiki tab)
- Other view-specific props (search query, ingest status, etc.)

## API consumption patterns

### Fetching pages

```tsx
const { pages, error, refresh } = usePages();

// pages is an array of { path, title, type, tags, link_count, backlink_count }
// error is a string (if fetch failed)
// refresh() re-fetches (used after ingest completes)
```

### Searching

```tsx
const [q, setQ] = useState("");
const [results, setResults] = useState<SearchHit[]>([]);
const [loading, setLoading] = useState(false);

async function search() {
  setLoading(true);
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=8`);
  const data = await res.json();
  setResults(data.results);
  setLoading(false);
}
```

Each result has:
- `path`, `title`, `type`, `tags`
- `snippet` (raw `<mark>`-wrapped FTS5 output)
- `snippet_html` (safe-to-inject, pre-escaped form)
- `score` (BM25 + vector hybrid rank)

### Asking (question synthesis)

```tsx
const response = await fetch("/api/query", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "how does this work?",
    use_llm: true,
    k: 8
  })
});

const { text, citations, hits, used_llm, error } = await response.json();

// text: the synthesized answer
// citations: array of { title, path, section }
// hits: retrieval results (same shape as search)
// used_llm: boolean (false if the LLM was unavailable)
// error: boolean (true if synthesis failed, but hits are still returned)
```

The API never 500s — if the LLM is unreachable, it returns the retrieval hits + a user-friendly error message instead.

### Ingesting files

```tsx
// Option 1: enqueue over files already in drop/
const res = await fetch("/api/ingest", { method: "POST" });
const { job_id } = await res.json();

// Option 2: upload new files
const formData = new FormData();
formData.append("files", file1);
formData.append("files", file2);

const res = await fetch("/api/upload", {
  method: "POST",
  body: formData
});

const { job_id, saved } = await res.json();

// Poll for status
setInterval(async () => {
  const res = await fetch(`/api/ingest/status?job_id=${job_id}`);
  const { done, progress, error, compiled, compiled_error } = await res.json();
  // done: true when all files ingested
  // progress: { current, total }
  // error: string if a parse/compile error occurred
  // compiled: count of pages compiled
  // compiled_error: count of compile errors
}, 500);
```

### Graph visualization

```tsx
const [nodes, setNodes] = useState([]);
const [edges, setEdges] = useState([]);

async function loadGraph() {
  const res = await fetch("/api/graph?mode=both");
  const { nodes, edges } = await res.json();
  setNodes(nodes);
  // node shape: { id, label, type, kind: "page"|"entity", degree,
  //   community?, level?, centrality?: { degree, eigenvector },
  //   parentCommunity? }
  // community/level/centrality are present only on entity nodes that have
  // at least one stored Leiden-community row; entities never clustered get
  // no extra keys, which is what lets deriveVizGraph fall back to its own
  // approximate client-side grouping.
  setEdges(edges); // { source, target, type, weight }
}

// The 3D scene (web/src/routes/graph/three/) renders this via
// React-Three-Fiber + a single-draw-call InstancedMesh2 node layer, with a
// worker (forceLayout.worker.ts) owning physics for all four graph modes.
// The 2D fallback (Graph2DFallback.tsx / Graph2DModeFallback.tsx) and the
// accessibility tree (a11y/) consume the same derived graph data.
```

## Build and deployment

### Development

```bash
npm run dev
```

Vite dev server at `http://localhost:5173/`. HMR enabled; changes hot-reload instantly.

### Production

```bash
npm run build
```

Outputs:
- `src/mythic_proportion/web/static_next/index.html` (single-file SPA entry point)
- `src/mythic_proportion/web/static_next/assets/*.js` and `*.css` (bundled, minified)
- `static_next/` is mounted by FastAPI at `/app` (see `web/app.py`)

The build is optimized for production:
- Tree-shaking (unused code removed)
- Code-splitting (lazy-loaded route bundles)
- CSS minification
- Asset hashing (cache busting)

### Serving

The FastAPI app (`src/mythic_proportion/web/app.py`) serves both frontends. `/static` is a plain `StaticFiles` mount for the legacy SPA's assets. `/app` uses a custom SPA-fallback route (`spa_app`), guarded by `STATIC_NEXT_DIR.is_dir()` so the route is registered at all only when a frontend build exists: a real file under `static_next/` (including hashed `assets/*` chunks) is served as-is; a bare client-side route (for example `/app/graph`) falls back to `index.html` so the client router can resolve it; but anything that looks like a missing static-file reference (lives under `assets/`, or has a file extension) stays a genuine 404 instead of being silently masked as a working route. A path-traversal attempt is rejected with 404 before any file access.

- `/` and `/static/*` — legacy vanilla-JS SPA, preserved unchanged for parity
- `/app/` — current React frontend (this guide)
- `/api/*` — Python API (all routes), CORS-restricted and CSRF-protected on state-changing POSTs — see `docs/architecture.md`

If `static_next/` doesn't exist (build hasn't run), `/app` returns 404. The build output is not committed to the repository, so run `npm install && npm run build` fresh after any checkout before `/app` will serve.

## Testing

```bash
npm run test
# or, matching CI:
npx vitest run
```

Current baseline: 380 vitest tests across 42 test files, all passing. Vitest covers:
- Component tests (`.test.tsx` files in `src/components/` and `src/routes/`)
- Contrast audits (design token WCAG compliance, including the generated community ramp at 8/16/32 community counts)
- Unit tests (lib functions, hooks, mode-transition and terrain-elevation logic)

`tsc --noEmit` is also clean. Coverage is tracked; aim for >80% on new features.

## What's not built yet

The frontend has no remaining scheduled work from the current plan. The
deferred, unscheduled items are backend/product scope, not frontend gaps:
an agent layer, an MCP server, a broader ComfyUI product asset pipeline
beyond the Knowledge Terrain chrome-asset capture, and retirement of the
legacy `/` single-page app. None of these are partially built; each needs
its own planning pass before implementation begins.

## Key files

| Path | Purpose |
|------|---------|
| `web/vite.config.ts` | Build config (base `/app`, outDir `static_next`) |
| `web/package.json` | Dependencies (React, R3F, `@three.ez/instanced-mesh`, `d3-force-3d`, Radix UI, cmdk, culori) |
| `web/src/App.tsx` | Root component, hash router, active tab state |
| `web/src/routes/*/` | Seven view components |
| `web/src/routes/graph/three/` | 3D scene, instanced node/edge layers, force-layout worker client, mode forces, mode transition blend, terrain surface/environment/landmarks |
| `web/src/routes/graph/a11y/` | Per-mode accessibility-tree views |
| `web/src/components/detail-pane/` | Shared reading/detail pane (Wiki, Search, Ask, Graph) |
| `web/src/components/shell/` | Header, TabNav (nav-plus-links pattern), AppShell layout |
| `web/src/components/command-palette/` | Cmd+K palette (Navigate/Pages/Graph/Actions sections) |
| `web/src/components/ui/` | Button, Input, Dialog, Tooltip, Combobox (shadcn-style) |
| `web/src/styles/tokens/` | Primitives, semantic, component, graph, motion tokens |
| `web/src/lib/graph-colors.ts` | The single culori OKLCH-to-`THREE.Color` bridge and generative community ramp |
| `web/src/lib/` | Hooks (`useTheme`, `usePages`), other utilities |
| `web/public/terrain/` | Placeholder Knowledge Terrain chrome assets + `ASSET_MANIFEST.json` |
| `src/mythic_proportion/web/app.py` | FastAPI mounts `/app` and `/static`, CORS/CSRF/upload-cap middleware |

## Performance considerations

- **React key stability** — use stable keys for lists (page path, not array index) to avoid re-renders
- **useMemo/useCallback** — memoize derived data and event handlers to avoid unnecessary re-renders
- **Lazy route imports** — code-split heavy routes (e.g., GraphView, AskView) to reduce initial bundle size
- **Token reads** — graph-token reads (`getComputedStyle`) are batched on theme change, not per-render
- **Single-draw-call node layer** — all four graph modes share one `InstancedMesh2` node layer with no per-node meshes, holding a single draw call at approximately 1,500 nodes and when stress-tested toward 10,000; a progressive-disclosure cap scales within that range. The physics worker owns layout for every mode so the main thread never blocks on simulation.
- **Bounded transitions** — mode-switch transitions are capped at roughly 800ms and are interruptible, so rapid mode switching never queues up animation work.

## Accessibility

- All interactive elements are keyboard-accessible (tab order, arrow keys, Enter/Space)
- Color is never the only way to distinguish meaning (pair with icons/glyphs/patterns) — this applies to the generated community ramp as much as to fixed-palette elements
- Motion respects `prefers-reduced-motion`: mode transitions resolve instantly, and Terrain/Cloud/Orbital/Strata all fall back to their 2D representation under WebGL context loss
- WCAG 4.5:1 contrast for body text, 3:1 for large text + UI (both themes), including generated community-ramp members and community-as-accent pairings, gated by `src/styles/__tests__/contrast.test.ts`
- Semantic HTML (`<button>`, `<input>`, `<fieldset>` for groups); `TabNav` uses real links with `aria-current="page"`, not an ARIA-tabs hybrid
- Two `aria-live` regions app-wide: one announces graph mode changes, the other covers the rest of the accessibility tree
- ARIA labels where needed (`aria-label`, `aria-describedby`)
- Command palette and Graph's per-mode accessibility tree are both fully keyboard-driven (no mouse required)
- No native browser dialogs (`alert`/`confirm`/`prompt`/`beforeunload`) anywhere in the frontend; confirmation/acknowledgement flows use the app-owned Radix `Dialog` (`web/src/components/ui/Dialog.tsx`)

## Debugging

**Chrome DevTools**
```
- React DevTools (Profiler, Components tree)
- Chrome Lighthouse (Perf, A11y, Best Practices)
- Network tab (API response payloads)
```

**Browser console**
```js
// Inspect current app state
console.log(document.querySelector('html').dataset.theme);

// Check token values
console.log(getComputedStyle(document.documentElement).getPropertyValue('--color-accent'));
```

**Vite HMR**
```
If hot reload fails, refresh the page. HMR works best with stable component state.
```
