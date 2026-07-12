"""Incremental GraphRAG re-index orchestration (Phase 3).

:func:`reindex_graph` is the single entry point that ties the rest of the
``graph`` package together: chunk every RAW ingested source
(:func:`mythic_proportion.web.pages.collect_raw_sources`; see below), diff
each source's text-unit ``content_hash`` set against what's already stored
(:class:`mythic_proportion.graph.store.GraphStore`), and for only the
new/changed units, run entity+relationship extraction (:mod:`.extract`) then
claim extraction (:mod:`.claims`) -- both cached read-through
(:mod:`.cache`), so an unchanged vault costs zero LLM calls on re-run.

**Source of truth (bugfix, Phase 3/4 GraphRAG extraction pipeline
investigation):** this defaults to :func:`~mythic_proportion.web.pages.collect_raw_sources`
(the original ``raw/`` ingested documents), NOT
:func:`~mythic_proportion.web.pages.collect_pages` (``wiki/``'s LLM-compiled,
char-capped summary pages) -- extracting from the compiled summaries
starved extraction of real source material on real vaults with substantial
source documents. A caller may still pass any pre-built ``PageInfo`` list
explicitly via ``pages=`` (tests do this to avoid re-walking disk).

Independently of this, :meth:`mythic_proportion.index.store.IndexStore.reindex`
still keeps the hybrid-search sidecar (``pages``/``pages_fts``/embeddings,
which back ``/api/search`` and the wikilink page graph) in sync with
``wiki/`` -- that is a separate, unaffected concern from GraphRAG's
raw-sourced extraction; see the ``mythic index-graph`` CLI command for the
intended call order (still: ``IndexStore.reindex`` then ``reindex_graph``).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.chunk import chunk_text
from mythic_proportion.graph.claims import extract_claims
from mythic_proportion.graph.extract import ExtractionClient, extract_entities_relationships
from mythic_proportion.graph.store import GraphReindexReport, GraphStore, ensure_graph_vec_tables
from mythic_proportion.index.embeddings import Embedder, l2_normalize
from mythic_proportion.web.pages import PageInfo, collect_raw_sources


class GraphExtractionSetupError(Exception):
    """Raised by :func:`build_extraction_client` when the configured LLM
    provider can't be constructed for GraphRAG extraction (missing
    credential, redaction enabled-but-unavailable, or an invalid local/
    Ollama configuration). Callers translate this into their own
    presentation -- the CLI's ``index-graph`` command prints it in red and
    exits 1; the web UI's background job worker records it as a job error.
    """


def build_extraction_client(settings: Any) -> ExtractionClient:
    """Build the (optionally redaction-wrapped) :class:`ExtractionClient`
    ``mythic index-graph`` and the web UI's "Build Knowledge Graph" job both
    route through -- a single shared implementation so the CLI and the web
    worker can never drift on provider selection, credential checks, or the
    redaction wrap (see ``memory/invariants.md``'s Phase 6 redact-before-any-
    cloud-call invariant).

    Phase 6: ``settings.local`` (or explicit ``llm_provider="ollama"``)
    routes entirely through Ollama, never AuthHub -- same per-vault
    "never touch the cloud" guarantee as ``compile``/``query`` (see
    :func:`mythic_proportion.query.engine._default_extraction_client`).
    """
    from mythic_proportion.config import authhub_api_key, authhub_base_url

    if settings.local or settings.llm_provider == "ollama":
        from mythic_proportion.llm.ollama import OllamaConfigError, OllamaExtractionClient, require_loopback_url

        if settings.local:
            try:
                require_loopback_url(settings.ollama_base_url, context="local mode (settings.local=True)")
            except OllamaConfigError as exc:
                raise GraphExtractionSetupError(str(exc)) from exc

        client: ExtractionClient = OllamaExtractionClient(
            base_url=settings.ollama_base_url, model=settings.ollama_model
        )
    else:
        api_key = authhub_api_key()
        if not api_key:
            raise GraphExtractionSetupError(
                "index-graph requires AUTHHUB_API_KEY to be set (or MYTHIC_LLM_PROVIDER=anthropic "
                "support, not yet wired for extraction; or MYTHIC_LOCAL=true / MYTHIC_LLM_PROVIDER=ollama "
                "for a fully-local run)."
            )

        from mythic_proportion.graph.extract import AuthHubExtractionClient

        client = AuthHubExtractionClient(
            base_url=authhub_base_url(settings),
            api_key=api_key,
            model=settings.llm_model,
            route_alias=settings.route_alias,
        )

    from mythic_proportion.privacy.redact import RedactingExtractionClient, RedactionUnavailableError, get_redactor

    try:
        redactor = get_redactor(settings)
    except RedactionUnavailableError as exc:
        raise GraphExtractionSetupError(f"Redaction is enabled but unavailable: {exc}") from exc
    if redactor is not None:
        client = RedactingExtractionClient(client, redactor)  # type: ignore[assignment]

    return client


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
    ``collect_raw_sources``/``collect_pages``) pass a pre-built page list
    instead of re-walking disk.
    """
    vault_root = Path(vault_root)
    store = GraphStore(conn)
    cache = LlmCache(conn)
    report = GraphReindexReport()

    if embedder is not None and vec_active:
        ensure_graph_vec_tables(conn, vec_active=vec_active, dim=embedder.dim)

    resolved_pages = pages if pages is not None else collect_raw_sources(vault_root)
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
