# Changelog

All notable changes to Mythic Proportion are documented here. This file is organized by phase (newest first), tracking the greenfield rebuild from Phase 0 onward.

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
- **FastAPI mount** — Phase 0 infrastructure (`web/app.py` mounts `/app` to `static_next/`) now serving the Phase 2 build; legacy vanilla-JS at `/` and `/static/*` remain untouched

### No-op changes

- The Python core remains unchanged and fully importable without optional extras (the parity floor).
- Structured LLM output stays prompted strict-JSON; no tool-calling assumption.

---

## Phase 1 — Design-system foundation (9162a12)

OKLCH three-tier design tokens + Cmd+K palette + light/dark theming + shadcn/ui component primitives.

### Design tokens

- **Tier 1 — Primitives** (`web/src/styles/tokens/primitives.css`): OKLCH color scales (neutral, accent, danger, warning, success) + spacing 4px base + modular type scale + radius + elevation shadows
- **Tier 2 — Semantic** (`web/src/styles/tokens/semantic.css`): `--color-*` (text primary/secondary/disabled, bg, border, accent), `--shadow-*`, dark-first + light overrides via `[data-theme="light"]`
- **Tier 3 — Component** (`web/src/styles/tokens/components.css`): button sizes, input states, dialog layering, etc.
- **Graph tokens** (`web/src/styles/tokens/graph.css`): `--graph-node-*` (source/entity/concept/session), `--graph-edge*`, `--graph-community-{1..8}` (categorical OKLCH ramp), `--graph-hull-fill`, `--graph-glow` — shared palette for 2D chrome and future Phase 5 3D scene via `THREE.Color` runtime read

### Components

- **Radix UI + shadcn/ui** (`web/src/components/ui/`) — headless, accessible, fully owned copies:
  - `Button` — button, link, and icon-button variants
  - `Input` — text, search, disabled states
  - `Dialog` — modal with focus trap and backdrop
  - `Tooltip` — popper-driven, keyboard-accessible
  - `Combobox` — fuzzy search, keyboard nav, autocomplete
- **Shell** (`web/src/components/shell/`) — `Header`, `TabNav`, `ThemeToggle`, `AppShell` layout wrapper
- **Command Palette** (`web/src/components/command-palette/CommandPalette.tsx`) — Cmd+K combobox-driven nav, fuzzy page/tab search, single source of truth for top-level routing

### Theming

- Dark mode is the default; light mode toggled via `data-theme="light"` on `<html>` root
- WCAG 4.5:1 contrast (body text) / 3:1 (large text + UI) audited in both themes (`src/styles/__tests__/contrast.test.ts`)
- Real-time theme switching via `useTheme()` hook; CSS custom properties update on toggle, no page reload

### Development

- `npm run dev` → Vite dev server at `http://localhost:5173`, HMR enabled
- `npm run build` → production build to `../src/mythic_proportion/web/static_next/`
- `npm run test` → Vitest unit + component tests
- TypeScript strict mode enabled (`web/tsconfig.json`)

---

## Phase 0 — Dual-repo + greenfield scaffold (813b532)

Python core unchanged. Greenfield `web/` Vite + React + R3F workspace scaffolded; `parity-checklist.md` frozen as Phase 2 acceptance contract.

### Scaffold

- `web/` — new Vite/React/TypeScript workspace alongside Python `src/mythic_proportion/`
- `vite.config.ts` — base path `/app/`, outDir `../src/mythic_proportion/web/static_next/`
- `package.json` — React 18, R3F, Radix UI (dependency layer)
- `src/main.tsx`, `App.tsx` — React entry point (hash-router, tab-state, design preview at `#/design`)
- `web/` build output mounted at `/app` in `web/app.py` only if the build directory exists; legacy SPA at `/` unaffected

### Parity contract

- `parity-checklist.md` — 123 items spanning all six CLI verbs, 11 web routes, 4 lint rules, ingest fast-path, hybrid search, and cross-cutting invariants (no-drift, lazy imports, strict-JSON, green tests). Phase 2 acceptance gate.

### Python core

- No structural changes; importable without optional extras; 102 tests green (baseline).
- `web/app.py` guards `/app` mount: `if STATIC_NEXT_DIR.is_dir()` (no-op if build hasn't run).
