import { useEffect, useState } from "react";
import { Button } from "../ui";
import { fetchPage, type PageDetail } from "../../lib/api";
import "./page-detail-pane.css";

// Phase 4d (plan Section 6.6 item 1; acceptance bar Section 9.3 journey 7):
// the shared "first-class reading/detail pane", used by any list-plus-detail
// view that needs to show a `PageDetail` in place, without leaving the view,
// while still offering an explicit "Open in Wiki" round trip. Wiki
// (WikiView.tsx's own `ReadingPane`) and Graph (GraphView.tsx's
// `mp-graph-reading-pane` aside) already have their own hard-preserved
// Phase 3/4c panes with the same four states; this component gives Search
// and Ask (which had none) the identical loading/empty/error/populated
// contract, extending the existing pattern rather than replacing either of
// the other two.
export function PageDetailPane({
  path,
  onOpenInWiki,
  emptyHint = "Select an item to see details.",
}: {
  /** The page path to show, or `null` for the "nothing selected" empty state. */
  path: string | null;
  onOpenInWiki: (path: string) => void;
  emptyHint?: string;
}) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setPage(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Clear stale content immediately on path change so a slow second fetch
    // never leaves the PREVIOUS page's body visible under a new selection.
    setPage(null);
    setError(null);
    setLoading(true);
    fetchPage(path)
      .then((detail) => {
        if (cancelled) return;
        setPage(detail);
      })
      .catch(() => {
        if (cancelled) return;
        setError(`Couldn't load that page: ${path}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <section className="mp-detail-pane" aria-label="Detail">
      {!path ? (
        <div className="mp-detail-pane-empty-state">{emptyHint}</div>
      ) : loading ? (
        <div className="mp-detail-pane-empty-state">Loading...</div>
      ) : error ? (
        <div className="mp-detail-pane-empty-state mp-detail-pane-error">{error}</div>
      ) : page ? (
        <div>
          <div className="mp-detail-pane-header">
            <h3>{page.title}</h3>
            <span className="mp-detail-pane-badge">{page.type}</span>
          </div>
          <div className="mp-detail-pane-path">{page.path}</div>
          {page.tags.length > 0 ? (
            <div className="mp-detail-pane-tag-list">
              {page.tags.map((tag) => (
                <span className="mp-detail-pane-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="mp-detail-pane-open"
            onClick={() => onOpenInWiki(page.path)}
          >
            Open in Wiki
          </Button>
          <div className="mp-detail-pane-body" dangerouslySetInnerHTML={{ __html: page.html }} />
        </div>
      ) : null}
    </section>
  );
}
