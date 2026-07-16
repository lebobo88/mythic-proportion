import { useCallback, useEffect, useState } from "react";
import { fetchPages, type PageListItem } from "./api";

// Shared page-list loader, used by both the Wiki view's sidebar and the
// Cmd+K palette's "jump to page" group -- one fetch, one source of truth,
// mirroring the legacy SPA's single global `allPages` (see
// src/mythic_proportion/web/static/app.js `loadPageList`). Never blanks the
// list on a slow/failed refresh: keeps the last-known-good pages and
// surfaces a hint instead.
export function usePages(): {
  pages: PageListItem[];
  error: string | null;
  refresh: () => void;
} {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchPages()
      .then((next) => {
        if (cancelled) return;
        setPages(next);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't refresh the page list -- showing the last known list.");
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { pages, error, refresh };
}
