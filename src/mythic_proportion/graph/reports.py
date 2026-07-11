"""Bottom-up community-report generation (Phase 4).

:func:`generate_community_reports` walks every ``(level, cluster)`` produced
by :mod:`mythic_proportion.graph.communities`, builds a small prompted
strict-JSON report request from that community's member entities +
relationships (:func:`build_community_report_prompt`), and persists the
result into ``community_reports`` (title/summary/full_content/rating) plus,
when an embedder + sqlite-vec are active, ``report_vectors``.

Every LLM call routes through the same read-through ``llm_cache`` used by
:mod:`mythic_proportion.graph.extract`/``.claims`` (see
:func:`mythic_proportion.graph.cache.read_through_complete`) -- since the
prompt is built deterministically from a community's *current* member set,
an unchanged community's prompt hashes identically across re-runs, making
report generation idempotent (cache hit -> zero new LLM calls, identical
report content) exactly like re-indexing an unchanged text unit already is.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from textwrap import dedent

from mythic_proportion.graph.cache import LlmCache, read_through_complete
from mythic_proportion.graph.extract import ExtractionClient
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.index.embeddings import Embedder, l2_normalize

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)

DEFAULT_TITLE = "Untitled community"
DEFAULT_RATING = 5.0


@dataclass
class CommunityReportsRunReport:
    """Counts of what :func:`generate_community_reports` did in one call."""

    reports_written: int = 0
    llm_calls: int = 0
    cache_hits: int = 0


def build_community_report_prompt(
    *, level: int, cluster: int, entities: list[dict], relationships: list[dict]
) -> tuple[str, str]:
    """System/user prompt pair for one community-report generation call.

    Mirrors the delimited-tuple extraction prompts' shape (:mod:`.tuples`)
    but for report generation the structured-output contract is a single
    top-level **strict-JSON object** (per the brief: "if JSON, single
    top-level object ... low temp ... normalize titles"), since a report is
    naturally object-shaped (title/summary/rating), not a repeated-record
    stream.
    """
    system = dedent(
        """\
        You are a community-report writer summarizing one cluster of a
        knowledge graph extracted from a personal wiki. Given the cluster's
        member entities and the relationships between them, write a report.

        Output ONLY a single top-level JSON object -- no prose, no markdown
        code fences -- with EXACTLY these keys:
        {"title": "<short descriptive title>",
         "summary": "<1-3 sentence summary>",
         "rating": <float 0-10, importance/impact of this community>}
        """
    )
    entity_lines = "\n".join(
        f"- {e['title']} ({e['type']}): {e['description']}" for e in entities
    ) or "(no member entities)"
    relationship_lines = (
        "\n".join(
            f"- {r['source_id']} -> {r['target_id']} ({r['type']}): {r['description']} "
            f"[weight {r['weight']}]"
            for r in relationships
        )
        or "(no relationships within this community)"
    )
    user = dedent(
        f"""\
        Community level {level}, cluster {cluster}.

        Member entities:
        {entity_lines}

        Relationships:
        {relationship_lines}

        Write the community report now, as the single JSON object described above.
        """
    )
    return system, user


def parse_community_report_response(raw: str) -> tuple[str, str, float]:
    """``(title, summary, rating)`` parsed from strict-JSON model output.

    Never raises -- malformed/non-JSON output degrades to a placeholder
    title/summary and the default rating, exactly like extraction degrades
    to an empty result on a persistent parse failure (skip-not-abort)."""
    match = _JSON_OBJECT_RE.search(raw)
    if match is None:
        return DEFAULT_TITLE, "", DEFAULT_RATING
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return DEFAULT_TITLE, "", DEFAULT_RATING
    if not isinstance(data, dict):
        return DEFAULT_TITLE, "", DEFAULT_RATING

    title = str(data.get("title") or DEFAULT_TITLE).strip() or DEFAULT_TITLE
    summary = str(data.get("summary") or "").strip()
    try:
        rating = float(data.get("rating", DEFAULT_RATING))
    except (TypeError, ValueError):
        rating = DEFAULT_RATING
    return title, summary, rating


def generate_community_reports(
    conn: sqlite3.Connection,
    *,
    client: ExtractionClient,
    cache: LlmCache | None = None,
    model: str = "mock",
    embedder: Embedder | None = None,
    vec_active: bool = False,
) -> CommunityReportsRunReport:
    """Generate (or refresh, cache-hit-idempotently) one community report per
    ``(level, cluster)`` currently in ``communities``. Every community's
    report is written unconditionally into ``community_reports`` (an
    upsert), but the LLM call itself is a no-op (cache hit) whenever the
    community's member set -- and therefore its prompt -- hasn't changed
    since the last run.

    Known accepted race (documented, not fixed -- see
    :meth:`mythic_proportion.graph.store.GraphStore.replace_communities`'s
    docstring for the matching note): a concurrent
    :meth:`~mythic_proportion.graph.store.GraphStore.replace_communities`
    call that prunes a ``(level, cluster)`` this loop is still iterating
    over can cause this loop's ``upsert_community_report`` to resurrect a
    report for a now-nonexistent cluster. Single-user/local usage makes
    this low-risk in practice; no locking added deliberately."""
    store = GraphStore(conn)
    cache = cache if cache is not None else LlmCache(conn)
    report = CommunityReportsRunReport()

    for (level, cluster), entity_ids in store.list_communities().items():
        entities = store.get_entities_by_ids(entity_ids)
        relationships = store.get_relationships_among(entity_ids)
        system, user = build_community_report_prompt(
            level=level, cluster=cluster, entities=entities, relationships=relationships
        )
        response, hit = read_through_complete(client, cache, system=system, user=user, model=model)
        if hit:
            report.cache_hits += 1
        else:
            report.llm_calls += 1

        title, summary, rating = parse_community_report_response(response)
        report_id = store.upsert_community_report(level, cluster, title, summary, response, rating)
        report.reports_written += 1

        if embedder is not None and vec_active:
            vector = l2_normalize(embedder.embed([f"{title}\n{summary}"])[0])
            store.upsert_report_vector(report_id, vector, vec_active=vec_active)

    return report
