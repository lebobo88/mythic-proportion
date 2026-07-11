"""Incremental GraphRAG re-index orchestration (Phase 3).

:func:`reindex_graph` is the single entry point that ties the rest of the
``graph`` package together: chunk every page (:mod:`.chunk`), diff each
page's text-unit ``content_hash`` set against what's already stored
(:class:`mythic_proportion.graph.store.GraphStore`), and for only the
new/changed units, run entity+relationship extraction (:mod:`.extract`) then
claim extraction (:mod:`.claims`) -- both cached read-through
(:mod:`.cache`), so an unchanged vault costs zero LLM calls on re-run.

Expects to be called **after** :meth:`mythic_proportion.index.store.IndexStore.reindex`
has already synced the ``pages`` table for this vault (``text_units.page_path``
references it) -- see the ``mythic index-graph`` CLI command for the intended
call order.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.chunk import chunk_text
from mythic_proportion.graph.claims import extract_claims
from mythic_proportion.graph.extract import ExtractionClient, extract_entities_relationships
from mythic_proportion.graph.store import GraphReindexReport, GraphStore, ensure_graph_vec_tables
from mythic_proportion.index.embeddings import Embedder, l2_normalize
from mythic_proportion.web.pages import PageInfo, collect_pages


def reindex_graph(
    vault_root: Path,
    conn: sqlite3.Connection,
    *,
    extraction_client: ExtractionClient,
    embedder: Embedder | None = None,
    vec_active: bool = False,
    model: str = "mock",
    max_gleanings: int = 1,
    pages: list[PageInfo] | None = None,
) -> GraphReindexReport:
    """Incrementally sync the graph layer with everything currently in ``wiki/``.

    Only text units whose content hash changed since the last call are
    re-extracted; unchanged units cost zero LLM calls and zero DB writes.
    Text units (and any resulting orphaned entities/relationships) for pages
    or chunks removed from disk are deleted, ref-counted via
    ``text_unit_entities`` so an entity still cited elsewhere survives.

    ``pages`` lets callers (tests, or a caller that already ran
    ``collect_pages``) pass a pre-built page list instead of re-walking disk.
    """
    vault_root = Path(vault_root)
    store = GraphStore(conn)
    cache = LlmCache(conn)
    report = GraphReindexReport()

    if embedder is not None and vec_active:
        ensure_graph_vec_tables(conn, vec_active=vec_active, dim=embedder.dim)

    resolved_pages = pages if pages is not None else collect_pages(vault_root)
    seen_paths = {page.path for page in resolved_pages}

    for page in resolved_pages:
        _reindex_one_page(
            page,
            store=store,
            cache=cache,
            report=report,
            extraction_client=extraction_client,
            embedder=embedder,
            vec_active=vec_active,
            model=model,
            max_gleanings=max_gleanings,
        )

    stale_paths = store.all_indexed_page_paths() - seen_paths
    for page_path in stale_paths:
        deleted_ids = store.delete_text_units_for_page(page_path)
        report.text_units_deleted += len(deleted_ids)

    # Entities first (their liveness is ref-counted purely via
    # `text_unit_entities`), then relationships (cleaned up as a cascade of
    # whichever entities just got deleted) -- see `GraphStore.delete_orphan_entities`.
    report.entities_deleted += store.delete_orphan_entities()
    store.delete_orphan_relationships()

    return report


def _reindex_one_page(
    page: PageInfo,
    *,
    store: GraphStore,
    cache: LlmCache,
    report: GraphReindexReport,
    extraction_client: ExtractionClient,
    embedder: Embedder | None,
    vec_active: bool,
    model: str,
    max_gleanings: int,
) -> None:
    chunks = chunk_text(page.body)
    existing = store.get_text_units_for_page(page.path)
    seen_chunk_indexes: set[int] = set()

    for chunk in chunks:
        seen_chunk_indexes.add(chunk.chunk_index)
        prior = existing.get(chunk.chunk_index)
        if prior is not None and prior[1] == chunk.content_hash:
            continue  # unchanged -- zero LLM calls, zero DB writes

        is_new = prior is None
        text_unit_id = store.upsert_text_unit(
            page.path, chunk.chunk_index, chunk.text, chunk.n_tokens, chunk.content_hash
        )
        if not is_new:
            store.clear_text_unit_entities(text_unit_id)

        entities, relationships, entity_calls = extract_entities_relationships(
            chunk.text,
            client=extraction_client,
            cache=cache,
            model=model,
            max_gleanings=max_gleanings,
        )
        report.llm_calls += entity_calls

        title_to_id: dict[str, int] = {}
        touched_entity_ids: set[int] = set()
        for entity in entities:
            entity_id = store.upsert_entity(entity.title, entity.type, entity.description)
            title_to_id[entity.title] = entity_id
            store.link_text_unit_entity(text_unit_id, entity_id)
            touched_entity_ids.add(entity_id)
            report.entities_upserted += 1
            if embedder is not None and vec_active:
                vector = l2_normalize(embedder.embed([f"{entity.title}\n{entity.description}"])[0])
                store.upsert_entity_vector(entity_id, vector, vec_active=vec_active)

        for relationship in relationships:
            source_id = title_to_id.get(relationship.source)
            target_id = title_to_id.get(relationship.target)
            if source_id is None or target_id is None:
                # Extraction referenced an entity title outside this chunk's
                # own tuple set -- skip rather than guess/invent an entity.
                continue
            store.upsert_relationship(source_id, target_id, "related", relationship.description, relationship.weight)
            touched_entity_ids.update({source_id, target_id})
            report.relationships_upserted += 1

        if title_to_id:
            claims, claim_calls = extract_claims(
                chunk.text, list(title_to_id.keys()), client=extraction_client, cache=cache, model=model
            )
            report.llm_calls += claim_calls
            for claim in claims:
                subject_id = title_to_id.get(claim.subject)
                if subject_id is None:
                    continue
                object_id = title_to_id.get(claim.object) if claim.object else None
                store.insert_claim(claim, subject_id=subject_id, object_id=object_id, text_unit_id=text_unit_id)
                report.claims_upserted += 1

        for entity_id in touched_entity_ids:
            store.recompute_degree(entity_id)

        if embedder is not None and vec_active:
            vector = l2_normalize(embedder.embed([chunk.text])[0])
            store.upsert_text_unit_vector(text_unit_id, vector, vec_active=vec_active)

        if is_new:
            report.text_units_added += 1
        else:
            report.text_units_updated += 1

    for chunk_index, (text_unit_id, _content_hash) in existing.items():
        if chunk_index not in seen_chunk_indexes:
            store.delete_text_unit(text_unit_id)
            report.text_units_deleted += 1
