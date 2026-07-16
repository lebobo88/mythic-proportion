# Frontend Guide

The Mythic Proportion frontend is a **Vite + React + React Three Fiber** application rebuilt on a three-tier OKLCH design-system foundation. It is served at `/app` by the same FastAPI process that hosts the Python core, with the legacy vanilla-JS SPA at `/` preserved for parity.

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

The build output is mounted automatically by FastAPI at `/app` (see `src/mythic_proportion/web/app.py` line 121–126).

## Architecture

### Seven views

All views consume the same `/api/*` routes the CLI uses, ensuring **no logic duplication between CLI and web**:

| View | Route | API endpoints |
|------|-------|---|
| **Wiki** | `#/wiki` (default) | `GET /api/pages`, `GET /api/page?path=...` |
| **Search** | `#/search` | `GET /api/search?q=...&k=...` |
| **Ask** | `#/ask` | `POST /api/query` |
| **Graph** | `#/graph` | `GET /api/graph` |
| **Ingest** | `#/ingest` | `POST /api/ingest`, `POST /api/upload`, `GET /api/ingest/status` |
| **Lint** | `#/lint` | `GET /api/lint`, `POST /api/lint/fix` |
| **Settings** | `#/settings` | `GET /api/config`, `POST /api/config`, `GET /api/models` |

Each view is a React component at `web/src/routes/{view-name}/` and is rendered by `App.tsx` based on the active tab.

### Design token system

A **three-tier hierarchy** ensures design consistency across the app and bridges to the future 3D scene:

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
- `--graph-edge`, `--graph-edge-active` — edge rendering
- `--graph-community-{1..8}` — a categorical OKLCH ramp for Leiden community visualization (Phase 3+)
- `--graph-hull-fill`, `--graph-glow` — community hull and accent effects
- Read at runtime via `getComputedStyle(...).getPropertyValue()` → `THREE.Color` for 2D/3D palette unity

All tokens are **CSS custom properties** — the single runtime source of truth. Theme changes via `data-theme` are instant (no reload); the 3D scene re-reads graph tokens on every theme toggle.

### Color philosophy

- **OKLCH everywhere** — perceptually even lightness, critical for graph visualization where node/community colors must remain distinguishable and equal-weight on a dark scene
- **Dark-first** — the default; light mode is an override for accessibility and daylight use
- **Contrast audited** — WCAG 4.5:1 (body text) / 3:1 (large text + UI) in both themes (`src/styles/__tests__/contrast.test.ts`)

### Cmd+K command palette

The **top-level navigation spine**. Launched via Cmd+K (Ctrl+K on Windows/Linux) or via a search icon in the header:

- **Fuzzy page search** — "jump to node" / "open page"
- **Tab quick-jump** — "go to Search", "go to Graph", etc.
- **Quick actions** — "run ingest", "run lint", etc.
- **Keyboard-driven** — no mouse required; same keyboard-first ethos as Obsidian

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
- Broadcasts theme change to the 3D scene (if Phase 5 is active)

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
  const res = await fetch("/api/graph");
  const { nodes, edges } = await res.json();
  setNodes(nodes); // { id, label, type }
  setEdges(edges); // { source, target }
}

// Phase 2: 2D canvas rendering (legacy graph.js)
// Phase 5: 3D WebGL with r3f-forcegraph layout + InstancedMesh rendering
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

The FastAPI app (`src/mythic_proportion/web/app.py`) serves both frontends:

```python
app.mount("/static", StaticFiles(directory="static/"), name="static")  # legacy SPA
if STATIC_NEXT_DIR.is_dir():
    app.mount("/app", StaticFiles(directory="static_next/", html=True), name="static_next")
```

- `/` and `/static/*` — legacy vanilla-JS SPA (unchanged from Phase 0)
- `/app/` — new React frontend (Phase 2 build output)
- `/api/*` — Python API (all routes)

If `static_next/` doesn't exist (build hasn't run), `/app` is not mounted and returns 404.

## Testing

```bash
npm run test
```

Vitest runs:
- Component tests (`.test.tsx` files in `src/components/` and `src/routes/`)
- Contrast audits (design token WCAG compliance)
- Unit tests (lib functions, hooks)

Coverage is tracked; aim for >80% on new features.

## Future phases

- **Phase 3** — GraphRAG entity/relationship layer: graph API adds semantic nodes/edges alongside wikilinks
- **Phase 4** — Communities + retrieval modes: hierarchical Leiden clustering, global/local/DRIFT query modes
- **Phase 5** — 3D graph frontend: r3f-forcegraph layout + InstancedMesh rendering at 50k node target, worker-frozen layout, GPU picking, hover/focus interactions, community hulls
- **Phase 6** — Privacy layer: PII redaction before cloud calls, local embeddings default (bge-small), optional Ollama local-LLM provider

Each phase adds features without breaking parity with the Python core or the seven views' API contracts.

## Key files

| Path | Purpose |
|------|---------|
| `web/vite.config.ts` | Build config (base `/app`, outDir `static_next`) |
| `web/package.json` | Dependencies (React, R3F, Radix UI, cmdk, culori) |
| `web/src/App.tsx` | Root component, hash router, active tab state |
| `web/src/routes/*/` | Seven view components |
| `web/src/components/shell/` | Header, TabNav, AppShell layout |
| `web/src/components/command-palette/` | Cmd+K palette |
| `web/src/components/ui/` | Button, Input, Dialog, Tooltip, Combobox (shadcn-style) |
| `web/src/styles/tokens/` | Primitives, semantic, component, graph tokens |
| `web/src/lib/` | Hooks (`useTheme`, `usePages`), utilities, graph-color bridge |
| `src/mythic_proportion/web/app.py` | FastAPI mounts `/app` and `/static` |

## Performance considerations

- **React key stability** — use stable keys for lists (page path, not array index) to avoid re-renders
- **useMemo/useCallback** — memoize derived data and event handlers to avoid unnecessary re-renders
- **Lazy route imports** — code-split heavy routes (e.g., GraphView, AskView) to reduce initial bundle size
- **Token reads** — graph-token reads (`getComputedStyle`) are batched on theme change, not per-render
- **Phase 5 note** — InstancedMesh rendering and worker-frozen layout are designed to hit 60fps at 50k nodes; see `ROADMAP-BRIEF.md` §6.3 for the perf budget

## Accessibility

- All interactive elements are keyboard-accessible (tab order, arrow keys, Enter/Space)
- Color is never the only way to distinguish meaning (pair with icons/labels)
- Motion respects `prefers-reduced-motion` (disabled auto-rotate in Phase 5)
- WCAG 4.5:1 contrast for body text, 3:1 for large text + UI (both themes)
- Semantic HTML (`<button>`, `<input>`, `<fieldset>` for groups)
- ARIA labels where needed (`aria-label`, `aria-describedby`)
- Command palette is keyboard-driven (no mouse required)

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
