"""SQLite-backed hybrid index storage (Phase 4).

:class:`IndexStore` owns a single SQLite database at ``<vault_root>/.index/``
holding three parallel views onto every wiki page:

* ``pages`` -- one row per page, keyed by content hash for incremental sync.
* ``pages_fts`` -- an FTS5 virtual table for BM25 sparse search (stdlib
  SQLite, always available).
* Vectors -- ``vec_pages`` (a ``sqlite-vec`` ``vec0`` virtual table) when the
  extension loads on this host, else ``page_vectors`` (plain BLOB storage)
  with cosine similarity computed in pure Python. **Both code paths expose
  the exact same public API** (:meth:`IndexStore.upsert_page`,
  :meth:`IndexStore.delete_page`, :meth:`IndexStore.vector_scores`, ...); no
  caller needs to know or care which one is active.

``sqlite-vec`` availability is auto-detected on :meth:`IndexStore.open`, but
can be forced off via ``use_vec=False`` (used by tests to exercise the
fallback path deterministically even on a host where the extension *does*
load).
"""

from __future__ import annotations

import hashlib
import sqlite3
import struct
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from mythic_proportion.compile.graph import derive_title
from mythic_proportion.compile.writer import parse_page
from mythic_proportion.index.embeddings import Embedder, l2_normalize
from mythic_proportion.vault.layout import WIKI_SUBDIRS

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")

INDEX_DB_RELATIVE_PATH = Path(".index") / "mythic.sqlite3"

_DIR_TO_PAGE_TYPE: dict[str, str] = {
    "sources": "source",
    "entities": "entity",
    "concepts": "concept",
    "sessions": "session",
}


@dataclass
class SearchHit:
    """One ranked result from :func:`mythic_proportion.index.retrieve.hybrid_search`
    or :meth:`IndexStore.bm25_search`."""

    page_path: str
    title: str
    score: float
    snippet: str
    tier: str  # "bm25" | "hybrid" | "expanded"


@dataclass
class ReindexReport:
    """Counts of what changed during one :meth:`IndexStore.reindex` call."""

    added: int = 0
    updated: int = 0
    deleted: int = 0
    unchanged: int = 0


def _content_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _pack_vector(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def _unpack_vector(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"{dim}f", blob))


class IndexStore:
    """Owns the SQLite hybrid-search sidecar for one vault.

    Usage::

        with IndexStore(vault_root, embedder=HashEmbedder()) as store:
            store.reindex(vault_root)
            hits = store.bm25_search("query")
    """

    def __init__(
        self,
        vault_root: Path,
        embedder: Embedder | None,
        *,
        use_vec: bool | None = None,
        db_path: Path | None = None,
        sync_embedder: bool = True,
    ) -> None:
        self._vault_root = Path(vault_root)
        self._db_path = Path(db_path) if db_path is not None else self._vault_root / INDEX_DB_RELATIVE_PATH
        self._embedder = embedder
        self._use_vec = use_vec
        self._conn: sqlite3.Connection | None = None
        self._vec_available = False
        # When False, `.open()` skips `_sync_embedder_meta()` entirely: no
        # meta read/write, no wipe-on-mismatch. This is for callers that only
        # need a connection onto whatever is already on disk (e.g. reading
        # the GraphRAG tables) and pass `embedder=None` *not* to mean "no
        # embedder configured" but "I'm not embedding anything in this open,
        # don't touch the embedder identity/state at all." Without this flag,
        # `embedder=None` -> `_embedder_id() == "none"`, which looks like a
        # real embedder-identity *change* against a vault indexed with a real
        # embedder and triggers `_sync_embedder_meta`'s destructive
        # DELETE FROM pages/pages_fts/page_vectors + DROP TABLE vec_pages.
        self._sync_embedder = sync_embedder

    # -- lifecycle ------------------------------------------------------

    @property
    def embedder(self) -> Embedder | None:
        return self._embedder

    @property
    def vec_active(self) -> bool:
        """True if this open store is actually using the ``sqlite-vec`` path."""
        return self._vec_available

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("IndexStore is not open -- call .open() or use it as a context manager")
        return self._conn

    def open(self) -> "IndexStore":
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        self._conn = conn
        self._vec_available = self._try_load_vec_extension()
        conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
        if self._sync_embedder:
            self._sync_embedder_meta()
        return self

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "IndexStore":
        return self.open()

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _try_load_vec_extension(self) -> bool:
        """Best-effort ``sqlite-vec`` load. Never raises -- any failure means fallback."""
        if self._use_vec is False:
            return False
        conn = self.conn
        try:
            conn.enable_load_extension(True)
        except AttributeError:
            return False
        try:
            import sqlite_vec
        except ImportError:
            conn.enable_load_extension(False)
            return False
        try:
            sqlite_vec.load(conn)
        except Exception:
            return False
        finally:
            conn.enable_load_extension(False)
        return True

    def _embedder_id(self) -> str:
        if self._embedder is None:
            return "none"
        return f"{type(self._embedder).__name__}:{self._embedder.dim}"

    def _get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row is not None else None

    def _set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _sync_embedder_meta(self) -> None:
        """Record embedder id/dim in ``meta``; wipe + rebuild if it changed.

        A stored embedder identity that no longer matches the active one
        means every previously-stored vector is meaningless (different
        model, different dimensionality) -- so we drop all indexed content
        and let the next :meth:`reindex` repopulate it from scratch, rather
        than silently mixing incompatible vectors.
        """
        conn = self.conn
        new_id = self._embedder_id()
        new_dim = self._embedder.dim if self._embedder is not None else 0
        stored_id = self._get_meta("embedder_id")

        if stored_id is not None and stored_id != new_id:
            conn.execute("DELETE FROM pages")
            conn.execute("DELETE FROM pages_fts")
            conn.execute("DELETE FROM page_vectors")
            if self._vec_available:
                conn.execute("DROP TABLE IF EXISTS vec_pages")

        if self._embedder is not None and self._vec_available:
            conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_pages "
                f"USING vec0(embedding float[{new_dim}] distance_metric=cosine)"
            )

        self._set_meta("embedder_id", new_id)
        self._set_meta("embedder_dim", str(new_dim))
        self._set_meta("index_version", "1")
        conn.commit()

    # -- single-page mutation --------------------------------------------

    def upsert_page(
        self,
        page_path: str,
        title: str,
        page_type: str,
        body: str,
        *,
        updated: str | None = None,
    ) -> bool:
        """Insert or update one page, keyed by a hash of ``body``.

        Returns ``True`` if the row was newly added or its content changed;
        ``False`` if an identical ``content_hash`` already existed (a no-op,
        used by :meth:`reindex` to count "unchanged" pages).
        """
        conn = self.conn
        content_hash = _content_hash(body)
        updated = updated or datetime.now(timezone.utc).isoformat()

        existing = conn.execute(
            "SELECT content_hash FROM pages WHERE page_path = ?", (page_path,)
        ).fetchone()
        if existing is not None and existing["content_hash"] == content_hash:
            return False

        conn.execute(
            "INSERT INTO pages(page_path, title, page_type, content_hash, updated) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(page_path) DO UPDATE SET "
            "title = excluded.title, page_type = excluded.page_type, "
            "content_hash = excluded.content_hash, updated = excluded.updated",
            (page_path, title, page_type, content_hash, updated),
        )
        conn.execute("DELETE FROM pages_fts WHERE page_path = ?", (page_path,))
        conn.execute(
            "INSERT INTO pages_fts(page_path, title, body) VALUES (?, ?, ?)",
            (page_path, title, body),
        )

        if self._embedder is not None:
            vector = self._embedder.embed([f"{title}\n\n{body}"])[0]
            self._upsert_vector(page_path, l2_normalize(vector))

        conn.commit()
        return True

    def _upsert_vector(self, page_path: str, vector: list[float]) -> None:
        conn = self.conn
        blob = _pack_vector(vector)
        conn.execute(
            "INSERT INTO page_vectors(page_path, dim, vector) VALUES (?, ?, ?) "
            "ON CONFLICT(page_path) DO UPDATE SET dim = excluded.dim, vector = excluded.vector",
            (page_path, len(vector), blob),
        )
        if self._vec_available:
            row = conn.execute("SELECT rowid FROM pages WHERE page_path = ?", (page_path,)).fetchone()
            if row is not None:
                conn.execute("DELETE FROM vec_pages WHERE rowid = ?", (row["rowid"],))
                conn.execute(
                    "INSERT INTO vec_pages(rowid, embedding) VALUES (?, ?)", (row["rowid"], blob)
                )

    def delete_page(self, page_path: str) -> None:
        """Remove one page from every table (pages / FTS / vectors)."""
        conn = self.conn
        if self._vec_available:
            row = conn.execute("SELECT rowid FROM pages WHERE page_path = ?", (page_path,)).fetchone()
            if row is not None:
                conn.execute("DELETE FROM vec_pages WHERE rowid = ?", (row["rowid"],))
        conn.execute("DELETE FROM pages WHERE page_path = ?", (page_path,))
        conn.execute("DELETE FROM pages_fts WHERE page_path = ?", (page_path,))
        conn.execute("DELETE FROM page_vectors WHERE page_path = ?", (page_path,))
        conn.commit()

    # -- bulk sync --------------------------------------------------------

    def _iter_wiki_pages_on_disk(self, vault_root: Path) -> dict[str, tuple[str, str, str]]:
        """Return ``{rel_page_path: (title, page_type, body)}`` for every page in ``wiki/``."""
        wiki_dir = vault_root / "wiki"
        found: dict[str, tuple[str, str, str]] = {}
        if not wiki_dir.is_dir():
            return found
        for sub in WIKI_SUBDIRS:
            sub_dir = wiki_dir / sub
            if not sub_dir.is_dir():
                continue
            for md_path in sorted(sub_dir.glob("*.md")):
                if not md_path.is_file():
                    continue
                text = md_path.read_text(encoding="utf-8")
                frontmatter, body = parse_page(text)
                page_type = str(frontmatter.get("type") or _DIR_TO_PAGE_TYPE.get(sub, sub))
                title = derive_title(frontmatter, body, md_path)
                rel_path = md_path.relative_to(vault_root).as_posix()
                found[rel_path] = (title, page_type, body)
        return found

    def reindex(self, vault_root: Path | None = None) -> ReindexReport:
        """Incrementally sync the index with everything currently in ``wiki/``.

        Only pages whose body content hash changed since the last sync are
        re-embedded/re-written; pages removed from disk since the last sync
        are deleted from the index. Returns counts for each bucket.
        """
        vault_root = Path(vault_root) if vault_root is not None else self._vault_root
        on_disk = self._iter_wiki_pages_on_disk(vault_root)

        existing_hashes = {
            row["page_path"]: row["content_hash"]
            for row in self.conn.execute("SELECT page_path, content_hash FROM pages")
        }

        report = ReindexReport()
        for rel_path, (title, page_type, body) in on_disk.items():
            content_hash = _content_hash(body)
            if rel_path not in existing_hashes:
                self.upsert_page(rel_path, title, page_type, body)
                report.added += 1
            elif existing_hashes[rel_path] != content_hash:
                self.upsert_page(rel_path, title, page_type, body)
                report.updated += 1
            else:
                report.unchanged += 1

        for rel_path in existing_hashes:
            if rel_path not in on_disk:
                self.delete_page(rel_path)
                report.deleted += 1

        return report

    # -- read paths used by retrieve.py ------------------------------------

    def all_page_paths(self) -> list[str]:
        return [row["page_path"] for row in self.conn.execute("SELECT page_path FROM pages")]

    def title_index(self) -> dict[str, tuple[str, str]]:
        """``{lowercased title: (page_path, title)}`` for every indexed page."""
        return {
            row["title"].lower(): (row["page_path"], row["title"])
            for row in self.conn.execute("SELECT page_path, title FROM pages")
        }

    def get_title(self, page_path: str) -> str:
        row = self.conn.execute("SELECT title FROM pages WHERE page_path = ?", (page_path,)).fetchone()
        return row["title"] if row is not None else page_path

    def get_body(self, page_path: str) -> str:
        row = self.conn.execute(
            "SELECT body FROM pages_fts WHERE page_path = ?", (page_path,)
        ).fetchone()
        return row["body"] if row is not None else ""

    def get_snippet(self, page_path: str, *, width: int = 160) -> str:
        body = self.get_body(page_path).strip()
        return body[:width] + ("..." if len(body) > width else "")

    def bm25_search(self, query: str, *, limit: int = 20) -> list[SearchHit]:
        """FTS5 BM25 sparse search. Returns [] for an empty/unusable query."""
        fts_query = _build_fts_match_query(query)
        if not fts_query:
            return []
        # Open/close markers are `<mark>`/`</mark>` rather than literal `[`/`]`
        # -- brackets collided with `[[wikilinks]]` (stacking into a noisy
        # `[[[Golden] [Ratio]]]`) and, being applied per matched *token*
        # (including stopwords), bracketed nearly every word. `<mark>` reads
        # cleanly and is unambiguous to strip/re-render safely on the way out
        # (see ``web.render.render_snippet_html`` / the Search view's
        # ``renderSnippet`` in ``app.js``, both of which escape-then-allow
        # only this exact tag pair).
        rows = self.conn.execute(
            "SELECT page_path, title, bm25(pages_fts) AS rank, "
            "snippet(pages_fts, 2, '<mark>', '</mark>', '...', 12) AS snip "
            "FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?",
            (fts_query, limit),
        ).fetchall()
        hits = []
        for row in rows:
            # bm25() is lower-is-better; negate so "higher score = more relevant"
            # holds uniformly across bm25/vector/hybrid scores.
            hits.append(SearchHit(row["page_path"], row["title"], -row["rank"], row["snip"], "bm25"))
        return hits

    def vector_scores(self, query_vector: list[float], candidate_paths: list[str]) -> dict[str, float]:
        """Cosine similarity of ``query_vector`` against each of ``candidate_paths``.

        Dispatches to the ``vec0`` extension if it's active, else pure-Python
        cosine over the ``page_vectors`` BLOB fallback store. Missing pages
        (no vector on file, e.g. embedder was ``None`` at index time) are
        simply absent from the returned dict.
        """
        if not candidate_paths or self._embedder is None:
            return {}
        if self._vec_available:
            return self._vec_vector_search(query_vector, candidate_paths)
        return self._fallback_vector_search(query_vector, candidate_paths)

    def _fallback_vector_search(
        self, query_vector: list[float], candidate_paths: list[str]
    ) -> dict[str, float]:
        placeholders = ",".join("?" for _ in candidate_paths)
        rows = self.conn.execute(
            f"SELECT page_path, dim, vector FROM page_vectors WHERE page_path IN ({placeholders})",
            candidate_paths,
        ).fetchall()
        scores: dict[str, float] = {}
        for row in rows:
            vector = _unpack_vector(row["vector"], row["dim"])
            scores[row["page_path"]] = _cosine(query_vector, vector)
        return scores

    def _vec_vector_search(
        self, query_vector: list[float], candidate_paths: list[str]
    ) -> dict[str, float]:
        total = self.conn.execute("SELECT COUNT(*) AS n FROM vec_pages").fetchone()["n"]
        if total == 0:
            return {}
        blob = _pack_vector(query_vector)
        rows = self.conn.execute(
            "SELECT rowid, distance FROM vec_pages WHERE embedding MATCH ? AND k = ? ORDER BY distance",
            (blob, total),
        ).fetchall()

        placeholders = ",".join("?" for _ in candidate_paths)
        rowid_to_path = {
            row["rowid"]: row["page_path"]
            for row in self.conn.execute(
                f"SELECT rowid, page_path FROM pages WHERE page_path IN ({placeholders})",
                candidate_paths,
            )
        }
        scores: dict[str, float] = {}
        for row in rows:
            page_path = rowid_to_path.get(row["rowid"])
            if page_path is not None:
                # cosine distance in [0, 2] -> similarity in [-1, 1].
                scores[page_path] = 1.0 - row["distance"]
        return scores


_FTS_TOKEN_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def _build_fts_match_query(query: str) -> str:
    """Turn a free-text query into a safe, OR'd FTS5 MATCH expression.

    Tokens are individually double-quoted so punctuation/hyphens in the
    query text can never be misparsed as FTS5 query-syntax operators; an
    OR join favors recall (the vector-rerank stage narrows relevance
    afterward, in ``retrieve.hybrid_search``).
    """
    tokens: list[str] = []
    current = []
    for ch in query:
        if ch in _FTS_TOKEN_CHARS:
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    if not tokens:
        return ""
    return " OR ".join(f'"{token}"' for token in tokens)
