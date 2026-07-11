import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/shell/AppShell";
import { TooltipProvider } from "./components/ui";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { DesignPreview } from "./routes/DesignPreview";
import { WikiView } from "./routes/wiki/WikiView";
import { SearchView } from "./routes/search/SearchView";
import { AskView } from "./routes/ask/AskView";
import { GraphView } from "./routes/graph/GraphView";
import { IngestView } from "./routes/ingest/IngestView";
import { LintView } from "./routes/lint/LintView";
import { SettingsView } from "./routes/settings/SettingsView";
import { useTheme } from "./lib/useTheme";
import { usePages } from "./lib/usePages";
import { TABS, type TabName } from "./components/shell/TabNav";

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

function App() {
  const { theme, toggle } = useTheme();
  const [activeTab, setActiveTab] = useState<TabName>(TABS[0]);
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

  if (hash === "#/design") {
    return (
      <TooltipProvider>
        <div style={{ padding: "var(--space-5)" }}>
          <DesignPreview />
        </div>
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
        {activeTab === "Ask" ? <AskView /> : null}
        {activeTab === "Graph" ? <GraphView onOpenPage={openPage} /> : null}
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
      />
    </TooltipProvider>
  );
}

export default App;
