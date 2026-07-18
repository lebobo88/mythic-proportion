import "./tab-nav.css";

// The seven legacy tabs (see specs/ROADMAP-BRIEF.md §1 "Current web routes")
// carried forward as the nav spine. Phase 1 only builds the shell; each
// tab's real content lands in Phase 2's parity rebuild.
export const TABS = ["Wiki", "Search", "Ask", "Graph", "Ingest", "Lint", "Settings"] as const;
export type TabName = (typeof TABS)[number];

// Phase 4c (plan Section 3.3/6.5): fixed from a non-conformant ARIA hybrid
// (`role="tab"`/`aria-selected` with no `aria-controls`/`role="tabpanel"`
// pairing and no roving-tabindex/Arrow-key support -- the APG tabs pattern
// half-implemented) to a conformant nav-plus-links pattern: a plain `<nav>`
// of real `<a>` items, current page communicated via `aria-current="page"`
// plus a non-color underline+bold cue (see tab-nav.css's `.mp-tab--active`),
// and ordinary Tab-key focus order -- nav-plus-links needs no roving
// tabindex because every link is independently focusable by design. Each
// href points at the same `/app/<tab>` path `App.tsx`'s `tabFromPathname`
// already parses on a direct load, so a tab is right-click/open-in-new-tab
// friendly even though the click handler below intercepts a normal click to
// stay a same-page SPA transition (no full reload, no state loss).
function tabHref(tab: TabName): string {
  return `/app/${tab}`;
}

export function TabNav({
  active,
  onSelect,
}: {
  active: TabName;
  onSelect: (tab: TabName) => void;
}) {
  return (
    <nav className="mp-tab-nav" aria-label="Primary">
      <ul>
        {TABS.map((tab) => (
          <li key={tab}>
            <a
              href={tabHref(tab)}
              aria-current={tab === active ? "page" : undefined}
              className={tab === active ? "mp-tab mp-tab--active" : "mp-tab"}
              onClick={(event) => {
                // Same-page SPA transition -- never a full navigation/reload
                // (that would tear down GraphView's worker/physics state,
                // exactly the excursion-survival guarantee Phase 4c's state-
                // lifecycle fix exists to protect).
                event.preventDefault();
                onSelect(tab);
              }}
            >
              {tab}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
