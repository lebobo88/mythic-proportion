import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/shell/AppShell";
import { TooltipProvider } from "./components/ui";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { DesignPreview } from "./routes/DesignPreview";
import { WikiView } from "./routes/wiki/WikiView";
import { SearchView } from "./routes/search/SearchView";
import { AskView } from "./routes/ask/AskView";
import { IngestView } from "./routes/ingest/IngestView";
import { LintView } from "./routes/lint/LintView";
import { SettingsView } from "./routes/settings/SettingsView";
import { useTheme } from "./lib/useTheme";
import { usePages } from "./lib/usePages";
import { requestGraphFocus } from "./lib/graphFocusBus";
import { TABS, type TabName } from "./components/shell/TabNav";

// Phase 5 perf hygiene (deliverable 11): three.js is ~150KB+ gz and doesn't
// tree-shake well -- lazy-load the Graph route so it never lands in the
// main bundle for users who never open the Graph tab.
const GraphView = lazy(() => import("./routes/graph/GraphView"));

// Phase 4a de-risking spike (plan Section 6.3): a second, independent
// lazy-loaded graph route, reachable at `#/mode-spike`, same reasoning as
// `#/design` below (an isolated hash route outside the seven-tab shell) --
// this keeps the spike's mode-switch prototype fully decoupled from
// production `GraphView`/`activeTab` state so it carries zero regression
// risk to the existing tab flow.
const ModeSpikeView = lazy(() => import("./routes/graph/ModeSpikeView"));

// Minimal hash router: `#/design` shows the living design-system preview
// (Phase 1 deliverable); `#/page?path=<encoded path>` (the same pattern the
// legacy SPA's wikilinks emit -- see
// src/mythic_proportion/web/static/app.js `handleHash`) jumps to the Wiki
// tab and opens that page; everything else shows the app shell with the
// active tab's view (Phase 2 rebuild on the Phase 1 design system).
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    function onHashChange() {
      setHash(window.location.hash);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return hash;
}

const PAGE_HASH_RE = /^#\/page\?path=(.+)$/;

// Browser-audit item 2 residual: the server-side SPA fallback (see
// `app.py`'s `spa_app`) already serves `index.html` (200) for any bare
// client-side route under `/app` (e.g. a direct load or hard refresh of
// `/app/graph`), but until this fix the client itself never read that path
// back out -- `activeTab` always started at `TABS[0]` ("Wiki") regardless of
// which path-style URL the app was actually loaded at. This mirrors the
// existing `#/page?path=...` hash-route handling above: read the initial
// path segment once (first render only -- in-app nav after that already
// keeps `activeTab` in sync via `setActiveTab`, it just doesn't push a new
// URL, so there's nothing further to read on subsequent renders) and select
// the matching tab, case-insensitively, falling back to the default tab for
// `/app`, `/app/`, or any segment that isn't one of the seven known tabs.
export function tabFromPathname(pathname: string): TabName | null {
  const match = pathname.match(/^\/app\/([^/?#]+)/i);
  if (!match) return null;
  const segment = match[1].toLowerCase();
  return TABS.find((tab) => tab.toLowerCase() === segment) ?? null;
}

function App() {
  const { theme, toggle } = useTheme();
  const [activeTab, setActiveTab] = useState<TabName>(
    () => tabFromPathname(window.location.pathname) ?? TABS[0],
  );
  // Graph state-lifecycle fix (plan Section 3.3/6.5): once the Graph tab has
  // been visited at least once, GraphView stays MOUNTED for the rest of the
  // session -- switching to any other tab (or the built-in "Open in Wiki"
  // action, which also flips `activeTab` to "Wiki") only hides it via the
  // native `hidden` attribute below, never unmounts it. Before this fix,
  // `{activeTab === "Graph" ? <GraphView/> : null}` destroyed GraphView's
  // worker/physics state, selection, filters, and expanded-node set on every
  // excursion, and cold-restarted physics on return. `graphEverVisited`
  // (rather than always-mounting GraphView from the very first render) keeps
  // the lazy-loaded three.js bundle and worker out of the critical path for
  // users who never open the Graph tab in a session, matching the existing
  // lazy-loading rationale above.
  const [graphEverVisited, setGraphEverVisited] = useState(activeTab === "Graph");
  useEffect(() => {
    if (activeTab === "Graph") setGraphEverVisited(true);
  }, [activeTab]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedPagePath, setSelectedPagePath] = useState<string | null>(null);
  const hash = useHashRoute();
  const { pages, error: pagesError, refresh: refreshPages } = usePages();

  useEffect(() => {
    const match = hash.match(PAGE_HASH_RE);
    if (match) {
      const path = decodeURIComponent(match[1]);
      setActiveTab("Wiki");
      setSelectedPagePath(path);
    }
  }, [hash]);

  const openPage = useCallback((path: string) => {
    window.location.hash = `#/page?path=${encodeURIComponent(path)}`;
    setActiveTab("Wiki");
    setSelectedPagePath(path);
  }, []);

  // Cmd+K "jump to page" also refocuses the Graph view on that node if/when
  // the user switches there -- see lib/graphFocusBus.ts.
  const jumpToGraphNode = useCallback((path: string) => {
    setActiveTab("Graph");
    requestGraphFocus(path);
  }, []);

  if (hash === "#/design") {
    return (
      <TooltipProvider>
        <div style={{ padding: "var(--space-5)" }}>
          <DesignPreview />
        </div>
      </TooltipProvider>
    );
  }

  // Phase 4a de-risking spike (plan Section 6.3) -- see ModeSpikeView.tsx.
  if (hash.startsWith("#/mode-spike")) {
    return (
      <TooltipProvider>
        <Suspense fallback={<p>Loading mode spike...</p>}>
          <ModeSpikeView />
        </Suspense>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <AppShell
        theme={theme}
        onToggleTheme={toggle}
        onOpenPalette={() => setPaletteOpen(true)}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
      >
        {activeTab === "Wiki" ? (
          <WikiView
            pages={pages}
            pagesError={pagesError}
            selectedPath={selectedPagePath}
            onSelectPath={openPage}
          />
        ) : null}
        {activeTab === "Search" ? <SearchView onOpenPage={openPage} /> : null}
        {activeTab === "Ask" ? <AskView onOpenPage={openPage} /> : null}
        {graphEverVisited ? (
          <div hidden={activeTab !== "Graph"}>
            <Suspense fallback={<p>Loading graph...</p>}>
              <GraphView
                onOpenPage={openPage}
                onGoToIngest={() => setActiveTab("Ingest")}
                visible={activeTab === "Graph"}
              />
            </Suspense>
          </div>
        ) : null}
        {activeTab === "Ingest" ? <IngestView onIngestComplete={refreshPages} /> : null}
        {activeTab === "Lint" ? <LintView /> : null}
        {activeTab === "Settings" ? <SettingsView /> : null}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSelectTab={setActiveTab}
        pages={pages}
        onJumpToPage={openPage}
        onJumpToGraphNode={jumpToGraphNode}
      />
    </TooltipProvider>
  );
}

export default App;
