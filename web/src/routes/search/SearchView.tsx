import { useEffect, useRef, useState } from "react";
import { Input } from "../../components/ui";
import { PageDetailPane } from "../../components/detail-pane/PageDetailPane";
import { runSearch, type SearchHit } from "../../lib/api";
import "./search.css";

// Search view: GET /api/search hybrid results with snippet highlighting --
// parity target for the legacy #view-search markup (see
// src/mythic_proportion/web/static/app.js `runSearch`). `snippet_html` is
// already pre-escaped server-side (see web.render.render_snippet_html), so
// rendering it verbatim matches the legacy behavior exactly.
//
// Phase 4d (plan Section 6.6 item 1; Section 9.3 journey 7): a first-class
// reading/detail pane now lives IN this view -- selecting a result shows its
// detail in place (shared `PageDetailPane`, same loading/empty/error/
// populated contract as Wiki/Graph's own panes) rather than immediately
// navigating away. `onOpenPage` is still the deliberate "Open in Wiki" round
// trip, now fired from inside the detail pane instead of on every card click.
export function SearchView({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setStatus("idle");
      setSelectedPath(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setStatus("loading");
      try {
        const hits = await runSearch(q, 8);
        setResults(hits);
        setStatus("idle");
      } catch {
        setStatus("error");
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div className="mp-search">
      <Input
        className="mp-search-input"
        placeholder="Search the vault..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search"
      />
      <div className="mp-search-body">
        <div className="mp-search-results">
          {status === "loading" ? <p className="mp-search-muted">Searching...</p> : null}
          {status === "error" ? <p className="mp-search-error">Search failed.</p> : null}
          {status === "idle" && query.trim() && results.length === 0 ? (
            <p className="mp-search-muted">No results.</p>
          ) : null}
          {results.map((hit) => (
            <button
              type="button"
              key={hit.page_path}
              className={
                hit.page_path === selectedPath
                  ? "mp-search-result-card mp-search-result-card--selected"
                  : selectedPath
                    ? "mp-search-result-card mp-context-dimmed"
                    : "mp-search-result-card"
              }
              aria-current={hit.page_path === selectedPath ? "true" : undefined}
              onClick={() => setSelectedPath(hit.page_path)}
            >
              <div className="mp-search-result-title">{hit.title}</div>
              <div className="mp-search-result-meta">
                {hit.tier} &middot; score {hit.score.toFixed(3)} &middot; {hit.page_path}
              </div>
              <div
                className="mp-search-result-snippet"
                dangerouslySetInnerHTML={{ __html: hit.snippet_html }}
              />
            </button>
          ))}
        </div>
        {results.length > 0 ? (
          <PageDetailPane
            path={selectedPath}
            onOpenInWiki={onOpenPage}
            emptyHint="Select a result to see details."
          />
        ) : null}
      </div>
    </div>
  );
}
