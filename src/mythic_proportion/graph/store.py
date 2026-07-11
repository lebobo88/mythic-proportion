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
        distinct description rather than overwriting the first one."""
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
            "SELECT id FROM entities WHERE title = ? AND type = ?", (title, type_)
        ).fetchone()
        self._conn.commit()
        return int(row["id"])

    def link_text_unit_entity(self, text_unit_id: int, entity_id: int) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO text_unit_entities(text_unit_id, entity_id) VALUES (?, ?)",
            (text_unit_id, entity_id),
        )
        self._conn.commit()

    def upsert_relationship(
        self, source_id: int, target_id: int, type_: str, description: str, weight: float
    ) -> int:
        self._conn.execute(
            "INSERT INTO relationships(source_id, target_id, type, description, weight) "
            "VALUES (?, ?, ?, ?, ?)",
            (source_id, target_id, type_, description, weight),
        )
        row = self._conn.execute("SELECT last_insert_rowid() AS id").fetchone()
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
        for entity_id in ids:
            self._conn.execute("DELETE FROM claims WHERE subject_id = ?", (entity_id,))
            self._conn.execute("DELETE FROM entities WHERE id = ?", (entity_id,))
            if has_entity_vectors:
                self._conn.execute("DELETE FROM entity_vectors WHERE rowid = ?", (entity_id,))
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

    # -- reads used by GET /api/graph?mode=entities|both ----------------------------

    def read_entity_graph(self) -> tuple[list[dict], list[dict]]:
        """``(nodes, edges)`` for every entity/relationship currently stored.

        Node/edge dict shape is deliberately distinct from the legacy
        wikilink-graph shape (adds ``kind``/``degree``/typed+weighted edges)
        -- callers combining both (``GET /api/graph?mode=both``) can tell
        them apart; callers of the legacy shape (the default,
        ``mode=wikilinks``) never see this at all.
        """
        nodes = [
            {
                "id": f"entity:{row['id']}",
                "label": row["title"],
                "type": row["type"],
                "kind": "entity",
                "degree": row["degree"],
            }
            for row in self._conn.execute("SELECT id, title, type, degree FROM entities")
        ]
        edges = [
            {
                "source": f"entity:{row['source_id']}",
                "target": f"entity:{row['target_id']}",
                "type": row["type"],
                "weight": row["weight"],
            }
            for row in self._conn.execute("SELECT source_id, target_id, type, weight FROM relationships")
        ]
        return nodes, edges
