import { useEffect, useRef, useState } from "react";
import { Input } from "../../components/ui";
import { runSearch, type SearchHit } from "../../lib/api";
import "./search.css";

// Search view: GET /api/search hybrid results with snippet highlighting --
// parity target for the legacy #view-search markup (see
// src/mythic_proportion/web/static/app.js `runSearch`). `snippet_html` is
// already pre-escaped server-side (see web.render.render_snippet_html), so
// rendering it verbatim matches the legacy behavior exactly.
export function SearchView({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setStatus("idle");
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
            className="mp-search-result-card"
            onClick={() => onOpenPage(hit.page_path)}
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
    </div>
  );
}
