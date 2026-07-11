import "./tab-nav.css";

// The seven legacy tabs (see specs/ROADMAP-BRIEF.md §1 "Current web routes")
// carried forward as the nav spine. Phase 1 only builds the shell; each
// tab's real content lands in Phase 2's parity rebuild.
export const TABS = ["Wiki", "Search", "Ask", "Graph", "Ingest", "Lint", "Settings"] as const;
export type TabName = (typeof TABS)[number];

export function TabNav({
  active,
  onSelect,
}: {
  active: TabName;
  onSelect: (tab: TabName) => void;
}) {
  return (
    <nav className="mp-tab-nav" aria-label="Primary">
      <ul role="tablist">
        {TABS.map((tab) => (
          <li key={tab}>
            <button
              role="tab"
              type="button"
              aria-selected={tab === active}
              className={tab === active ? "mp-tab mp-tab--active" : "mp-tab"}
              onClick={() => onSelect(tab)}
            >
              {tab}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
