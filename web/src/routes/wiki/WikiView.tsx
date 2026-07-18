import { useEffect, useMemo, useState } from "react";
import { Input } from "../../components/ui";
import { fetchPage, type PageDetail, type PageListItem } from "../../lib/api";
import "./wiki.css";

// Wiki view: page-list sidebar with filter + a reading pane, wired to
// GET /api/pages and GET /api/page -- parity target for the legacy
// #view-wiki markup in src/mythic_proportion/web/static/index.html +
// app.js (`loadPageList`/`renderPageList`/`openPage`/`renderPage`).
export function WikiView({
  pages,
  pagesError,
  selectedPath,
  onSelectPath,
}: {
  pages: PageListItem[];
  pagesError: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState<PageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (p) => p.title.toLowerCase().includes(q) || p.tags.join(" ").toLowerCase().includes(q),
    );
  }, [pages, filter]);

  useEffect(() => {
    if (!selectedPath) {
      setPage(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPage(selectedPath)
      .then((detail) => {
        if (cancelled) return;
        setPage(detail);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(`Page not found: ${selectedPath}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  return (
    <div className="mp-wiki">
      <aside className="mp-wiki-sidebar">
        <Input
          className="mp-wiki-filter"
          placeholder="Filter pages..."
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter pages"
        />
        {pagesError ? <p className="mp-wiki-hint">{pagesError}</p> : null}
        <div className="mp-wiki-page-list">
          {filtered.length === 0 ? (
            <div className="mp-wiki-empty">No pages yet.</div>
          ) : (
            filtered.map((item) => (
              <button
                type="button"
                key={item.path}
                className={
                  item.path === selectedPath
                    ? "mp-wiki-page-item mp-wiki-page-item--selected"
                    : selectedPath
                      ? "mp-wiki-page-item mp-context-dimmed"
                      : "mp-wiki-page-item"
                }
                aria-current={item.path === selectedPath ? "true" : undefined}
                onClick={() => onSelectPath(item.path)}
              >
                <div className="mp-wiki-page-item-title">{item.title}</div>
                <div className="mp-wiki-page-item-meta">
                  <span className={`mp-wiki-type-dot mp-wiki-type-dot--${item.type}`} />
                  {item.type} &middot; {item.link_count} out &middot; {item.backlink_count} in
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
      <section className="mp-wiki-reading-pane">
        {loading ? (
          <div className="mp-wiki-empty-state">Loading...</div>
        ) : loadError ? (
          <div className="mp-wiki-empty-state">{loadError}</div>
        ) : !page ? (
          <div className="mp-wiki-empty-state">Select a page from the list.</div>
        ) : (
          <ReadingPane page={page} onNavigate={onSelectPath} />
        )}
      </section>
    </div>
  );
}

function ReadingPane({
  page,
  onNavigate,
}: {
  page: PageDetail;
  onNavigate: (path: string) => void;
}) {
  return (
    <div>
      <div className="mp-wiki-page-header">
        <h2>{page.title}</h2>
        <span className="mp-wiki-badge">{page.type}</span>
      </div>
      <div className="mp-wiki-page-path">{page.path}</div>
      <div className="mp-wiki-tag-list">
        {page.tags.map((tag) => (
          <span className="mp-wiki-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="mp-wiki-page-body" dangerouslySetInnerHTML={{ __html: page.html }} />
      {page.outbound.length > 0 ? (
        <div className="mp-wiki-links">
          <h3>Outbound links ({page.outbound.length})</h3>
          <ul>
            {page.outbound.map((link) => (
              <li key={link.title}>
                {link.path ? (
                  <a
                    className="mp-wiki-link"
                    href={`#/page?path=${encodeURIComponent(link.path)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(link.path as string);
                    }}
                  >
                    {link.title}
                  </a>
                ) : (
                  <span className="mp-wiki-link mp-wiki-link--dangling">{link.title}</span>
                )}
                {!link.path ? " (missing)" : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mp-wiki-links">
        <h3>Backlinks ({page.backlinks.length})</h3>
        {page.backlinks.length > 0 ? (
          <ul>
            {page.backlinks.map((link) => (
              <li key={link.title}>
                {link.path ? (
                  <a
                    className="mp-wiki-link"
                    href={`#/page?path=${encodeURIComponent(link.path)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(link.path as string);
                    }}
                  >
                    {link.title}
                  </a>
                ) : (
                  link.title
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mp-wiki-muted">No backlinks yet.</p>
        )}
      </div>
      <details className="mp-wiki-raw-toggle">
        <summary>Raw Markdown</summary>
        <pre>{page.raw_markdown}</pre>
      </details>
    </div>
  );
}
