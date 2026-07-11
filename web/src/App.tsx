import { useEffect, useState } from "react";
import { AppShell } from "./components/shell/AppShell";
import { TooltipProvider } from "./components/ui";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { DesignPreview } from "./routes/DesignPreview";
import { useTheme } from "./lib/useTheme";
import { TABS, type TabName } from "./components/shell/TabNav";

// Minimal hash router: `#/design` shows the living design-system preview
// (Phase 1 deliverable); everything else shows the app shell. Real per-tab
// views (Wiki/Search/Ask/Graph/Ingest/Lint/Settings) land in Phase 2 on top
// of this shell + the design system built here.
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

function TabPlaceholder({ tab }: { tab: TabName }) {
  return (
    <div>
      <h1>{tab}</h1>
      <p>
        The {tab} view is rebuilt on this design system in Phase 2 (core rebuild + data
        migration + parity gate). This shell, its tokens, and its components are the Phase 1
        deliverable.
      </p>
    </div>
  );
}

function App() {
  const { theme, toggle } = useTheme();
  const [activeTab, setActiveTab] = useState<TabName>(TABS[0]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const hash = useHashRoute();

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
        <TabPlaceholder tab={activeTab} />
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSelectTab={setActiveTab}
      />
    </TooltipProvider>
  );
}

export default App;
