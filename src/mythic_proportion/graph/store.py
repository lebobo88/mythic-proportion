"""SQLite persistence for the GraphRAG data layer (Phase 3).

:class:`GraphStore` owns every read/write against the ``entities`` /
``relationships`` / ``text_units`` / ``text_unit_entities`` / ``claims``
tables added to the shared index DB (``index/schema.sql``). It deliberately
takes a plain ``sqlite3.Connection`` rather than opening its own -- these
tables live in the *same* database file as ``pages``/``pages_fts``/
``page_vectors`` (see :class:`mythic_proportion.index.store.IndexStore`), so
callers open one ``IndexStore`` and hand its ``.conn`` to a ``GraphStore``.

SQLite foreign keys are declared in the schema for documentation only (this
project never sets ``PRAGMA foreign_keys = ON``), so every delete path here
is explicit: :meth:`GraphStore.delete_text_unit` walks
``claims`` -> ``text_unit_entities`` -> ``text_units`` itself, and
:meth:`GraphStore.delete_orphan_entities` ref-counts provenance via
``text_unit_entities`` rather than trusting a cascade.
"""

from __future__ import annotations

import struct
import sqlite3
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mythic_proportion.graph.claims import ExtractedClaim

#: The three graph-layer `vec0` tables, sized to the active embedder's `dim`
#: exactly like `vec_pages` in `IndexStore._sync_embedder_meta` -- created
#: here (not in schema.sql) for the same reason: column width isn't known
#: until an embedder is chosen. `report_vectors` is created but stays empty
#: until Phase 4 (community reports don't exist yet).
_GRAPH_VEC_TABLES: tuple[str, ...] = ("entity_vectors", "text_unit_vectors", "report_vectors")


def _pack_vector(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", (name,)
    ).fetchone()
    return row is not None


def ensure_graph_vec_tables(conn: sqlite3.Connection, *, vec_active: bool, dim: int) -> None:
    """Create the graph-layer sibling ``vec0`` tables at ``dim`` width.

    No-op when ``vec_active`` is False or ``dim`` is non-positive -- mirrors
    ``vec_pages``'s own gating, so a host without the ``sqlite-vec``
    extension simply never gets these tables (entity/text-unit vectors are
    then never written; every other graph feature still works).
    """
    if not vec_active or dim <= 0:
        return
    for name in _GRAPH_VEC_TABLES:
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {name} "
            f"USING vec0(embedding float[{dim}] distance_metric=cosine)"
        )
    conn.commit()


@dataclass
class GraphReindexReport:
    """Counts of what changed during one :func:`mythic_proportion.graph.index.reindex_graph` call."""

    text_units_added: int = 0
    text_units_updated: int = 0
    text_units_deleted: int = 0
    entities_upserted: int = 0
    relationships_upserted: int = 0
    claims_upserted: int = 0
    llm_calls: int = 0
    entities_deleted: int = 0


class GraphStore:
    """Owns entity/relationship/claim/text-unit persistence over the shared index DB."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    # -- text units -----------------------------------------------------------

    def get_text_units_for_page(self, page_path: str) -> dict[int, tuple[int, str]]:
        """``{chunk_index: (text_unit_id, content_hash)}`` for every stored unit of ``page_path``."""
        rows = self._conn.execute(
            "SELECT id, chunk_index, content_hash FROM text_units WHERE page_path = ?",
            (page_path,),
        ).fetchall()
        return {row["chunk_index"]: (row["id"], row["content_hash"]) for row in rows}

    def upsert_text_unit(
        self, page_path: str, chunk_index: int, text: str, n_tokens: int, content_hash: str
    ) -> int:
        self._conn.execute(
            "INSERT INTO text_units(page_path, chunk_index, text, n_tokens, content_hash) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(page_path, chunk_index) DO UPDATE SET "
            "text = excluded.text, n_tokens = excluded.n_tokens, content_hash = excluded.content_hash",
            (page_path, chunk_index, text, n_tokens, content_hash),
        )
        row = self._conn.execute(
            "SELECT id FROM text_units WHERE page_path = ? AND chunk_index = ?",
            (page_path, chunk_index),
        ).fetchone()
        self._conn.commit()
        return int(row["id"])

    def clear_text_unit_entities(self, text_unit_id: int) -> None:
        """Drop every entity association for ``text_unit_id`` (called before
        re-extracting a *changed* unit, so stale provenance never lingers)."""
        self._conn.execute("DELETE FROM text_unit_entities WHERE text_unit_id = ?", (text_unit_id,))
        self._conn.execute("DELETE FROM claims WHERE text_unit_id = ?", (text_unit_id,))
        self._conn.commit()

    def delete_text_unit(self, text_unit_id: int) -> None:
        self._conn.execute("DELETE FROM claims WHERE text_unit_id = ?", (text_unit_id,))
        self._conn.execute("DELETE FROM text_unit_entities WHERE text_unit_id = ?", (text_unit_id,))
        self._conn.execute("DELETE FROM text_units WHERE id = ?", (text_unit_id,))
        if _table_exists(self._conn, "text_unit_vectors"):
            self._conn.execute("DELETE FROM text_unit_vectors WHERE rowid = ?", (text_unit_id,))
        self._conn.commit()

    def delete_text_units_for_page(self, page_path: str) -> list[int]:
        ids = [
            row["id"]
            for row in self._conn.execute(
                "SELECT id FROM text_units WHERE page_path = ?", (page_path,)
            )
        ]
        for text_unit_id in ids:
            self.delete_text_unit(text_unit_id)
        return ids

    def all_indexed_page_paths(self) -> set[str]:
        return {
            row["page_path"] for row in self._conn.execute("SELECT DISTINCT page_path FROM text_units")
        }

    # -- entities / relationships ----------------------------------------------

    def upsert_entity(self, title: str, type_: str, description: str) -> int:
        """Insert or merge one entity, deduped on ``(title, type)`` (both
        callers are expected to have already normalized ``title`` via
        ``tuples.normalize_title``). A conflicting re-mention appends a new,
        distinct description rather than overwriting the first one.

        Also mirrors the row into ``entities_fts`` (Phase 4: one of the two
        seed sources -- "FTS5 BM25 UNION sqlite-vec cosine" -- for
        spreading-activation/LOCAL/DRIFT), exactly like ``IndexStore.upsert_page``
        keeps ``pages_fts`` in sync."""
        self._conn.execute(
            "INSERT INTO entities(title, type, description) VALUES (?, ?, ?) "
            "ON CONFLICT(title, type) DO UPDATE SET description = CASE "
            "  WHEN entities.description = '' THEN excluded.description "
            "  WHEN excluded.description = '' OR excluded.description = entities.description "
            "    THEN entities.description "
            "  ELSE entities.description || ' ' || excluded.description "
            "END",
            (title, type_, description),
        )
        row = self._conn.execute(
            "SELECT id, description FROM entities WHERE title = ? AND type = ?", (title, type_)
        ).fetchone()
        entity_id = int(row["id"])
        if _table_exists(self._conn, "entities_fts"):
            self._conn.execute("DELETE FROM entities_fts WHERE entity_id = ?", (entity_id,))
            self._conn.execute(
                "INSERT INTO entities_fts(entity_id, title, description) VALUES (?, ?, ?)",
                (entity_id, title, row["description"]),
            )
        self._conn.commit()
        return entity_id

    def link_text_unit_entity(self, text_unit_id: int, entity_id: int) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO text_unit_entities(text_unit_id, entity_id) VALUES (?, ?)",
            (text_unit_id, entity_id),
        )
        self._conn.commit()

    def upsert_relationship(
        self, source_id: int, target_id: int, type_: str, description: str, weight: float
    ) -> int:
        """Insert or merge one relationship, deduped on the identity
        ``(source_id, target_id, type)`` enforced by
        ``idx_relationships_identity`` in ``index/schema.sql``. The same
        logical edge extracted from multiple text-units (or re-extracted
        across re-index passes) merges into the surviving row instead of
        creating a duplicate: the stronger (max) weight wins, and the
        description is replaced only when the incoming one is non-empty
        (empty descriptions never clobber an existing one). ``RETURNING id``
        (not ``last_insert_rowid()``, which is wrong on the UPDATE path) is
        used so this returns the correct id whether the row was inserted or
        merged."""
        row = self._conn.execute(
            "INSERT INTO relationships(source_id, target_id, type, description, weight) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(source_id, target_id, type) DO UPDATE SET "
            "  weight = MAX(relationships.weight, excluded.weight), "
            "  description = CASE "
            "    WHEN excluded.description != '' THEN excluded.description "
            "    ELSE relationships.description "
            "  END "
            "RETURNING id",
            (source_id, target_id, type_, description, weight),
        ).fetchone()
        self._conn.commit()
        return int(row["id"])

    def recompute_degree(self, entity_id: int) -> None:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM relationships WHERE source_id = ? OR target_id = ?",
            (entity_id, entity_id),
        ).fetchone()
        self._conn.execute("UPDATE entities SET degree = ? WHERE id = ?", (row["n"], entity_id))
        self._conn.commit()

    def delete_orphan_relationships(self) -> int:
        """Delete any relationship whose source/target entity no longer exists
        (defense in depth -- FKs aren't pragma-enforced, see the module docstring)."""
        rows = self._conn.execute(
            "SELECT r.id FROM relationships r "
            "WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.source_id) "
            "   OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.target_id)"
        ).fetchall()
        ids = [row["id"] for row in rows]
        for relationship_id in ids:
            self._conn.execute("DELETE FROM relationships WHERE id = ?", (relationship_id,))
        if ids:
            self._conn.commit()
        return len(ids)

    def delete_orphan_entities(self) -> int:
        """Delete every entity with zero remaining text-unit provenance --
        the ref-count described in the brief. ``text_unit_entities`` is the
        single source of truth for whether an entity is still "live";
        relationships are edges that follow an entity's lifecycle (cleaned
        up separately by :meth:`delete_orphan_relationships`, called
        *after* this), not something that additionally protects an entity
        from deletion (the ``relationships`` table has no independent
        chunk-provenance column of its own -- see ``index/schema.sql``)."""
        rows = self._conn.execute(
            "SELECT e.id FROM entities e "
            "WHERE NOT EXISTS (SELECT 1 FROM text_unit_entities tue WHERE tue.entity_id = e.id)"
        ).fetchall()
        ids = [row["id"] for row in rows]
        has_entity_vectors = _table_exists(self._conn, "entity_vectors")
        has_entities_fts = _table_exists(self._conn, "entities_fts")
        for entity_id in ids:
            self._conn.execute("DELETE FROM claims WHERE subject_id = ?", (entity_id,))
            self._conn.execute("DELETE FROM entities WHERE id = ?", (entity_id,))
            if has_entity_vectors:
                self._conn.execute("DELETE FROM entity_vectors WHERE rowid = ?", (entity_id,))
            if has_entities_fts:
                self._conn.execute("DELETE FROM entities_fts WHERE entity_id = ?", (entity_id,))
        if ids:
            self._conn.commit()
        return len(ids)

    # -- claims -----------------------------------------------------------------

    def insert_claim(
        self,
        claim: "ExtractedClaim",
        *,
        subject_id: int,
        object_id: int | None,
        text_unit_id: int,
    ) -> int:
        self._conn.execute(
            "INSERT INTO claims(subject_id, object_id, type, status, description, "
            "period_start, period_end, text_unit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                subject_id,
                object_id,
                claim.type,
                claim.status,
                claim.description,
                claim.period_start,
                claim.period_end,
                text_unit_id,
            ),
        )
        row = self._conn.execute("SELECT last_insert_rowid() AS id").fetchone()
        self._conn.commit()
        return int(row["id"])

    # -- vectors ------------------------------------------------------------------

    def upsert_text_unit_vector(self, text_unit_id: int, vector: list[float], *, vec_active: bool) -> None:
        if not vec_active:
            return
        blob = _pack_vector(vector)
        self._conn.execute("DELETE FROM text_unit_vectors WHERE rowid = ?", (text_unit_id,))
        self._conn.execute(
            "INSERT INTO text_unit_vectors(rowid, embedding) VALUES (?, ?)", (text_unit_id, blob)
        )
        self._conn.commit()

    def upsert_entity_vector(self, entity_id: int, vector: list[float], *, vec_active: bool) -> None:
        if not vec_active:
            return
        blob = _pack_vector(vector)
        self._conn.execute("DELETE FROM entity_vectors WHERE rowid = ?", (entity_id,))
        self._conn.execute("INSERT INTO entity_vectors(rowid, embedding) VALUES (?, ?)", (entity_id, blob))
        self._conn.commit()

    def upsert_report_vector(self, report_id: int, vector: list[float], *, vec_active: bool) -> None:
        if not vec_active:
            return
        blob = _pack_vector(vector)
        self._conn.execute("DELETE FROM report_vectors WHERE rowid = ?", (report_id,))
        self._conn.execute("INSERT INTO report_vectors(rowid, embedding) VALUES (?, ?)", (report_id, blob))
        self._conn.commit()

    def entity_vector_scores(
        self, query_vector: list[float], candidate_ids: list[int], *, vec_active: bool
    ) -> dict[int, float]:
        """Cosine similarity of ``query_vector`` against ``entity_vectors`` for
        ``candidate_ids`` -- mirrors ``IndexStore._vec_vector_search``/
        ``_fallback_vector_search`` exactly, just keyed on entity id instead
        of page path."""
        if not candidate_ids:
            return {}
        if vec_active and _table_exists(self._conn, "entity_vectors"):
            return self._entity_vector_scores_vec(query_vector, candidate_ids)
        return self._entity_vector_scores_fallback(query_vector, candidate_ids)

    def _entity_vector_scores_vec(
        self, query_vector: list[float], candidate_ids: list[int]
    ) -> dict[int, float]:
        total = self._conn.execute("SELECT COUNT(*) AS n FROM entity_vectors").fetchone()["n"]
        if total == 0:
            return {}
        blob = _pack_vector(query_vector)
        rows = self._conn.execute(
            "SELECT rowid, distance FROM entity_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance",
            (blob, total),
        ).fetchall()
        candidates = set(candidate_ids)
        scores: dict[int, float] = {}
        for row in rows:
            if row["rowid"] in candidates:
                scores[int(row["rowid"])] = 1.0 - row["distance"]
        return scores

    def _entity_vector_scores_fallback(
        self, query_vector: list[float], candidate_ids: list[int]
    ) -> dict[int, float]:
        if not _table_exists(self._conn, "entity_vectors"):
            return {}
        # `entity_vectors` (a vec0 table) can't be scanned without the
        # extension loaded -- callers on a host with no sqlite-vec simply get
        # no vector scores here (spreading-activation/LOCAL/DRIFT still work
        # off the FTS5 lexical seed set alone in that case).
        return {}

    def report_vector_scores(
        self, query_vector: list[float], candidate_ids: list[int], *, vec_active: bool
    ) -> dict[int, float]:
        """Cosine similarity of ``query_vector`` against ``report_vectors``
        for ``candidate_ids`` -- used by DRIFT's primer report selection.
        Returns ``{}`` (never raises) when vectors aren't active/available,
        exactly like :meth:`entity_vector_scores`'s no-vec fallback."""
        if not candidate_ids or not vec_active or not _table_exists(self._conn, "report_vectors"):
            return {}
        total = self._conn.execute("SELECT COUNT(*) AS n FROM report_vectors").fetchone()["n"]
        if total == 0:
            return {}
        blob = _pack_vector(query_vector)
        rows = self._conn.execute(
            "SELECT rowid, distance FROM report_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance",
            (blob, total),
        ).fetchall()
        candidates = set(candidate_ids)
        return {int(row["rowid"]): 1.0 - row["distance"] for row in rows if row["rowid"] in candidates}

    def search_entities_fts(self, query: str, *, limit: int = 20) -> list[tuple[int, float]]:
        """FTS5 BM25 lexical seed search over entity title+description.

        Returns ``[(entity_id, score)]`` with higher-is-better scores (bm25()
        is negated, exactly like ``IndexStore.bm25_search``). ``[]`` for an
        empty/unusable query or if ``entities_fts`` doesn't exist yet."""
        from mythic_proportion.index.store import _build_fts_match_query

        if not _table_exists(self._conn, "entities_fts"):
            return []
        fts_query = _build_fts_match_query(query)
        if not fts_query:
            return []
        rows = self._conn.execute(
            "SELECT entity_id, bm25(entities_fts) AS rank FROM entities_fts "
            "WHERE entities_fts MATCH ? ORDER BY rank LIMIT ?",
            (fts_query, limit),
        ).fetchall()
        return [(int(row["entity_id"]), -float(row["rank"])) for row in rows]

    # -- communities / community reports (Phase 4) -----------------------------

    def replace_communities(self, rows: list[tuple[int, int, int | None, int]]) -> None:
        """Atomically replace the entire ``communities`` table with ``rows``
        (``(level, cluster, parent_cluster, entity_id)`` tuples), and --
        in the *same* transaction -- prune any ``community_reports`` (and
        matching ``report_vectors``) rows whose ``(level, cluster)`` no
        longer appears in the freshly-persisted set.

        Runs as one explicit transaction (``BEGIN IMMEDIATE`` .. ``COMMIT``)
        so a concurrent reader (e.g. a query mode reading community
        membership, or GLOBAL/DRIFT reading ``community_reports``,
        mid-request) either sees the *old* full clustering with its old
        (still-valid) reports, or the *new* clustering with stale reports
        already gone -- never a mix where a report for a now-nonexistent
        cluster remains visible to GLOBAL/DRIFT retrieval. This closes the
        "stale report" data-integrity gap: report *content* for surviving
        clusters is still refreshed later by
        :func:`mythic_proportion.graph.reports.generate_community_reports`
        (which is cache-idempotent and out of scope for this transaction),
        but a cluster that disappears on re-cluster can never again be
        retrieved once this call returns, regardless of whether report
        regeneration runs afterward. Whole-graph recompute (delete-then-insert
        the full ``communities`` table) is deliberately cheap-and-simple at
        personal-vault scale rather than diffing, matching upstream
        GraphRAG's own choice.

        Known accepted race (documented, not fixed -- cross-vendor review
        flagged this; no locking added deliberately): if a concurrent
        caller is mid-way through :func:`mythic_proportion.graph.reports.generate_community_reports`
        for the *old* clustering while this method replaces it, that
        caller's subsequent ``upsert_community_report``/``upsert_report_vector``
        calls can re-insert a report for a ``(level, cluster)`` this
        transaction just pruned -- a narrow "report resurrection" window.
        This app is single-user/local (one `mythic index-graph`/`compute
        communities` invocation at a time, in practice), so the risk is
        judged low enough not to warrant a lock; revisit only if
        `index-graph`/report generation ever becomes concurrent-multi-caller.
        """
        surviving = {(level, cluster) for level, cluster, _parent, _entity in rows}
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            self._conn.execute("DELETE FROM communities")
            self._conn.executemany(
                "INSERT INTO communities(level, cluster, parent_cluster, entity_id) VALUES (?, ?, ?, ?)",
                rows,
            )
            self._prune_stale_community_reports(surviving)
        except Exception:
            self._conn.rollback()
            raise
        else:
            self._conn.commit()

    def _prune_stale_community_reports(self, surviving: set[tuple[int, int]]) -> None:
        """Delete every ``community_reports`` row (and its ``report_vectors``
        counterpart, if that table exists) whose ``(level, cluster)`` is not
        in ``surviving``. Caller-transaction-scoped -- never commits/rolls
        back itself; see :meth:`replace_communities`, the only caller."""
        stale_ids = [
            int(row["id"])
            for row in self._conn.execute("SELECT id, level, cluster FROM community_reports")
            if (row["level"], row["cluster"]) not in surviving
        ]
        if not stale_ids:
            return
        has_report_vectors = _table_exists(self._conn, "report_vectors")
        for report_id in stale_ids:
            self._conn.execute("DELETE FROM community_reports WHERE id = ?", (report_id,))
            if has_report_vectors:
                self._conn.execute("DELETE FROM report_vectors WHERE rowid = ?", (report_id,))

    def all_entity_ids(self) -> list[int]:
        return [row["id"] for row in self._conn.execute("SELECT id FROM entities")]

    def list_communities(self) -> dict[tuple[int, int], list[int]]:
        """``{(level, cluster): [entity_id, ...]}`` for every stored community."""
        grouped: dict[tuple[int, int], list[int]] = {}
        for row in self._conn.execute(
            "SELECT level, cluster, entity_id FROM communities ORDER BY level, cluster, entity_id"
        ):
            grouped.setdefault((row["level"], row["cluster"]), []).append(row["entity_id"])
        return grouped

    def community_levels(self) -> list[int]:
        return [
            row["level"]
            for row in self._conn.execute("SELECT DISTINCT level FROM communities ORDER BY level")
        ]

    def max_community_level(self) -> int:
        row = self._conn.execute("SELECT MAX(level) AS m FROM communities").fetchone()
        return int(row["m"]) if row is not None and row["m"] is not None else 0

    def communities_for_entities(self, entity_ids: list[int], *, level: int) -> list[tuple[int, int]]:
        """``[(cluster, entity_id)]`` at ``level`` for the given entities."""
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT cluster, entity_id FROM communities WHERE level = ? AND entity_id IN ({placeholders})",
            (level, *entity_ids),
        ).fetchall()
        return [(int(row["cluster"]), int(row["entity_id"])) for row in rows]

    def communities_full_for_entities(
        self, entity_ids: list[int]
    ) -> list[tuple[int, int, int | None, int]]:
        """``[(level, cluster, parent_cluster, entity_id)]`` for every stored
        community row touching any of ``entity_ids``, across EVERY level --
        unlike :meth:`communities_for_entities` (single-level lookup), this
        is what the `/api/graph` per-node Leiden projection (Phase 4b, plan
        Section 6.4/7) needs to report each entity's finest-level community
        plus its coarser ancestor chain (``parentCommunity``, keyed by
        level). An entity id absent from the ``communities`` table entirely
        (never Leiden-clustered, e.g. added since the last `mythic
        index-graph`) simply has no rows here -- callers must not fabricate
        one."""
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT level, cluster, parent_cluster, entity_id FROM communities "
            f"WHERE entity_id IN ({placeholders}) ORDER BY entity_id, level",
            entity_ids,
        ).fetchall()
        return [
            (
                int(row["level"]),
                int(row["cluster"]),
                int(row["parent_cluster"]) if row["parent_cluster"] is not None else None,
                int(row["entity_id"]),
            )
            for row in rows
        ]

    def get_entities_by_ids(self, entity_ids: list[int]) -> list[dict]:
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT id, title, type, description, degree FROM entities WHERE id IN ({placeholders})",
            entity_ids,
        ).fetchall()
        return [dict(row) for row in rows]

    def get_relationships_among(self, entity_ids: list[int]) -> list[dict]:
        """Every relationship whose *both* endpoints are in ``entity_ids``."""
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT source_id, target_id, type, description, weight FROM relationships "
            f"WHERE source_id IN ({placeholders}) AND target_id IN ({placeholders})",
            (*entity_ids, *entity_ids),
        ).fetchall()
        return [dict(row) for row in rows]

    def relationships_touching(self, entity_ids: list[int]) -> list[dict]:
        """Every relationship touching *at least one* of ``entity_ids`` (used
        by local-expansion/spreading-activation, unlike
        :meth:`get_relationships_among` which requires *both* endpoints)."""
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT source_id, target_id, type, description, weight FROM relationships "
            f"WHERE source_id IN ({placeholders}) OR target_id IN ({placeholders})",
            (*entity_ids, *entity_ids),
        ).fetchall()
        return [dict(row) for row in rows]

    def text_units_for_entities(self, entity_ids: list[int], *, limit: int = 20) -> list[dict]:
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT DISTINCT tu.id, tu.page_path, tu.chunk_index, tu.text FROM text_units tu "
            f"JOIN text_unit_entities tue ON tue.text_unit_id = tu.id "
            f"WHERE tue.entity_id IN ({placeholders}) LIMIT ?",
            (*entity_ids, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def claims_for_entities(self, entity_ids: list[int], *, limit: int = 20) -> list[dict]:
        if not entity_ids:
            return []
        placeholders = ",".join("?" for _ in entity_ids)
        rows = self._conn.execute(
            f"SELECT id, subject_id, object_id, type, status, description FROM claims "
            f"WHERE subject_id IN ({placeholders}) OR object_id IN ({placeholders}) LIMIT ?",
            (*entity_ids, *entity_ids, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def upsert_community_report(
        self, level: int, cluster: int, title: str, summary: str, full_content: str, rating: float
    ) -> int:
        row = self._conn.execute(
            "INSERT INTO community_reports(level, cluster, title, summary, full_content, rating) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(level, cluster) DO UPDATE SET "
            "title = excluded.title, summary = excluded.summary, "
            "full_content = excluded.full_content, rating = excluded.rating "
            "RETURNING id",
            (level, cluster, title, summary, full_content, rating),
        ).fetchone()
        self._conn.commit()
        return int(row["id"])

    def list_community_reports(self, *, level: int | None = None) -> list[dict]:
        if level is None:
            rows = self._conn.execute(
                "SELECT * FROM community_reports ORDER BY level, cluster"
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM community_reports WHERE level = ? ORDER BY cluster", (level,)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_community_report(self, level: int, cluster: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM community_reports WHERE level = ? AND cluster = ?", (level, cluster)
        ).fetchone()
        return dict(row) if row is not None else None

    # -- reads used by GET /api/graph?mode=entities|both ----------------------------

    def entity_source_page_paths(self) -> dict[int, set[str]]:
        """``{entity_id: {text-unit page_path, ...}}`` -- each entity's
        extraction provenance: the set of source documents (as recorded in
        ``text_units.page_path``, e.g. ``raw/<content-hash>.md`` for a real
        ``reindex_graph`` run over ingested sources) whose text units the
        entity was actually extracted from, via the ``text_unit_entities``
        ref-count table that is already this store's single source of truth
        for entity liveness (see :meth:`delete_orphan_entities`).

        Added for ``GET /api/graph?mode=both``'s page/entity identity dedup
        (Codex CODE_REVIEW finding J-001): a page/entity title match alone is
        not identity -- the merge additionally requires the page's own
        ``source_hash`` to name a document in this provenance set. Distinct
        pairs only; an entity with no remaining text-unit links (transiently
        possible mid-reindex, before orphan cleanup) is simply absent."""
        result: dict[int, set[str]] = {}
        for row in self._conn.execute(
            "SELECT DISTINCT tue.entity_id, tu.page_path FROM text_unit_entities tue "
            "JOIN text_units tu ON tu.id = tue.text_unit_id"
        ):
            result.setdefault(int(row["entity_id"]), set()).add(str(row["page_path"]))
        return result

    def read_entity_graph(self) -> tuple[list[dict], list[dict]]:
        """``(nodes, edges)`` for every entity/relationship currently stored.

        Node/edge dict shape is deliberately distinct from the legacy
        wikilink-graph shape (adds ``kind``/``degree``/typed+weighted edges)
        -- callers combining both (``GET /api/graph?mode=both``) can tell
        them apart; callers of the legacy shape (the default,
        ``mode=wikilinks``) never see this at all.

        T2 remediation (3D graph intermittent-collapse investigation, round
        3): both queries carry an explicit ``ORDER BY`` now. SQLite's own
        documentation is explicit that row order is undefined without one;
        this mattered here because the client's `d3-force-3d` worker seeds
        each node's INITIAL position purely from its ARRAY INDEX (a
        deterministic golden-angle spiral) -- so an otherwise-identical graph
        returned in a different row order starts physics from a genuinely
        different configuration, and a mostly-disconnected, weakly-contained
        graph can settle into a different (including visually collapsed)
        equilibrium depending on that starting order. This closes that
        undefined-order gap; see `tests/test_graph.py`'s
        `test_read_entity_graph_returns_nodes_and_edges_in_stable_ascending_id_order`
        for the regression coverage (RED without the `ORDER BY`, GREEN with
        it, using a delete/reinsert history so a fresh-insert-order
        coincidence can't mask the missing guarantee).
        """
        nodes = [
            {
                "id": f"entity:{row['id']}",
                "label": row["title"],
                "type": row["type"],
                "kind": "entity",
                "degree": row["degree"],
            }
            for row in self._conn.execute("SELECT id, title, type, degree FROM entities ORDER BY id")
        ]
        edges = [
            {
                "source": f"entity:{row['source_id']}",
                "target": f"entity:{row['target_id']}",
                "type": row["type"],
                "weight": row["weight"],
            }
            for row in self._conn.execute(
                "SELECT source_id, target_id, type, weight FROM relationships "
                "ORDER BY source_id, target_id, type"
            )
        ]
        return nodes, edges
