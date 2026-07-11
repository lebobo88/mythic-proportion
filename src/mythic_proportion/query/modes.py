"""The four GraphRAG query modes (Phase 4): global / local / DRIFT /
spreading-activation, all expressed over sqlite-vec + FTS5 + recursive CTEs
on top of the Phase 3 graph layer.

Every mode's *retrieval* half is plain SQL (deterministic, network-free);
only the final answer-synthesis step calls an LLM, and every such call goes
through the same read-through ``llm_cache`` used by :mod:`mythic_proportion.graph.extract`
(:func:`mythic_proportion.graph.cache.read_through_complete`), via the
:class:`~mythic_proportion.graph.extract.ExtractionClient` protocol (a plain
``complete(system, user) -> str`` shape) -- **not** the tool-calling
:class:`~mythic_proportion.query.client.AnswerClient` the legacy hybrid-search
answer path uses, per the "structured LLM output is prompted strict-JSON, no
native tool-calling" constraint. This means every mode here can be tested
end-to-end with :class:`~mythic_proportion.graph.extract.FakeExtractionClient`,
exactly like the rest of the graph package.

Seeds for LOCAL/DRIFT/spreading-activation are ``FTS5(entities_fts) BM25 UNION
sqlite-vec(entity_vectors) cosine`` (:func:`select_seed_entities`), blended
with the exact same weights :func:`mythic_proportion.index.retrieve.hybrid_search`
uses for pages, just re-keyed onto entities.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field

from mythic_proportion.graph.cache import LlmCache, read_through_complete
from mythic_proportion.graph.extract import ExtractionClient
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.index.embeddings import Embedder, l2_normalize

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
_JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)

_BM25_WEIGHT = 0.45
_VECTOR_WEIGHT = 0.55

DEFAULT_SEED_LIMIT = 5
DEFAULT_LOCAL_HOPS = 2
DEFAULT_ACTIVATION_DECAY = 0.6
DEFAULT_ACTIVATION_THRESHOLD = 0.05
DEFAULT_ACTIVATION_MAX_HOPS = 4
DEFAULT_MAX_CONTEXT_CHARS = 6000
DEFAULT_GLOBAL_BATCH_SIZE = 5
DEFAULT_GLOBAL_TOP_N = 10
DEFAULT_DRIFT_K_REPORTS = 5
DEFAULT_DRIFT_MAX_FOLLOW_UPS = 3


@dataclass
class RatedPoint:
    """One map-step key point + relevance score (GLOBAL search)."""

    point: str
    score: float


@dataclass
class ModeResult:
    """The outcome of one query-mode call -- shaped closely enough to
    :class:`mythic_proportion.query.engine.QueryAnswer` that
    ``query.engine.answer_query`` can adapt it with a thin wrapper."""

    text: str
    citations: list[str] = field(default_factory=list)
    mode: str = ""
    used_llm: bool = False
    entity_ids: list[int] = field(default_factory=list)
    points: list[RatedPoint] = field(default_factory=list)
    qa_tree: list[dict[str, str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Seed selection -- FTS5 BM25 UNION sqlite-vec cosine, blended
# ---------------------------------------------------------------------------


def select_seed_entities(
    conn: sqlite3.Connection,
    query: str,
    *,
    embedder: Embedder | None,
    vec_active: bool,
    limit: int = DEFAULT_SEED_LIMIT,
) -> dict[int, float]:
    """``{entity_id: blended_score}`` for the top ``limit`` seed entities.

    Blends FTS5 BM25 lexical hits with sqlite-vec cosine similarity using the
    exact same ``0.45``/``0.55`` weighting
    :func:`mythic_proportion.index.retrieve.hybrid_search` uses for pages.
    Degrades to BM25-only when no embedder is configured (mirrors
    ``hybrid_search``'s own no-embedder degrade path).
    """
    store = GraphStore(conn)
    bm25_hits = dict(store.search_entities_fts(query, limit=max(limit * 4, 20)))

    if embedder is None:
        ranked = sorted(bm25_hits.items(), key=lambda kv: kv[1], reverse=True)
        return dict(ranked[:limit])

    query_vector = l2_normalize(embedder.embed([query])[0])
    candidate_ids = list(bm25_hits) or store.all_entity_ids()
    vector_scores = store.entity_vector_scores(query_vector, candidate_ids, vec_active=vec_active)

    max_bm25 = max(bm25_hits.values(), default=0.0) or 1.0
    all_ids = set(candidate_ids) | set(bm25_hits)
    combined: dict[int, float] = {}
    for entity_id in all_ids:
        bm25_norm = bm25_hits.get(entity_id, 0.0) / max_bm25
        vector_score = max(vector_scores.get(entity_id, 0.0), 0.0)
        combined[entity_id] = _BM25_WEIGHT * bm25_norm + _VECTOR_WEIGHT * vector_score

    ranked = sorted(combined.items(), key=lambda kv: kv[1], reverse=True)
    return dict(ranked[:limit])


# ---------------------------------------------------------------------------
# LOCAL: recursive-CTE N-hop neighbor expansion
# ---------------------------------------------------------------------------


def local_expand(
    conn: sqlite3.Connection, seed_entity_ids: list[int], *, hops: int = DEFAULT_LOCAL_HOPS
) -> list[int]:
    """Recursive-CTE N-hop neighbor expansion from ``seed_entity_ids``.

    Returns every entity id reachable within ``hops`` relationship-edges of
    any seed (seeds themselves included, at hop 0), ordered by hop distance
    then entity id -- the closest, most-relevant-first ordering LOCAL search
    ranks by. ``[]`` for an empty seed list."""
    if not seed_entity_ids:
        return []
    placeholders = ",".join("?" for _ in seed_entity_ids)
    sql = f"""
        WITH RECURSIVE expand(entity_id, hop) AS (
            SELECT id, 0 FROM entities WHERE id IN ({placeholders})
            UNION
            SELECT
                CASE WHEN r.source_id = e.entity_id THEN r.target_id ELSE r.source_id END,
                e.hop + 1
            FROM relationships r
            JOIN expand e ON (r.source_id = e.entity_id OR r.target_id = e.entity_id)
            WHERE e.hop < ?
        )
        SELECT entity_id, MIN(hop) AS hop FROM expand GROUP BY entity_id ORDER BY hop, entity_id
    """
    rows = conn.execute(sql, (*seed_entity_ids, hops)).fetchall()
    return [int(row["entity_id"]) for row in rows]


def _gather_context(
    store: GraphStore, entity_ids: list[int], *, max_chars: int = DEFAULT_MAX_CONTEXT_CHARS
) -> tuple[str, list[str]]:
    """Assemble a token-budget-capped context block (entities + text units +
    claims) for ``entity_ids``. Returns ``(context_text, entity_titles)``."""
    if not entity_ids:
        return "", []
    entities = store.get_entities_by_ids(entity_ids)
    text_units = store.text_units_for_entities(entity_ids, limit=10)
    claims = store.claims_for_entities(entity_ids, limit=10)

    lines: list[str] = []
    for entity in entities:
        lines.append(f"Entity: {entity['title']} ({entity['type']}) -- {entity['description']}")
    for text_unit in text_units:
        lines.append(
            f"Text unit ({text_unit['page_path']}#{text_unit['chunk_index']}): {text_unit['text']}"
        )
    for claim in claims:
        lines.append(f"Claim ({claim['status']}, {claim['type']}): {claim['description']}")

    context_text = "\n".join(lines)
    return context_text[:max_chars], [entity["title"] for entity in entities]


# ---------------------------------------------------------------------------
# Spreading-activation: weighted scored BFS via recursive CTE
# ---------------------------------------------------------------------------


def spreading_activation(
    conn: sqlite3.Connection,
    seed_scores: dict[int, float],
    *,
    decay: float = DEFAULT_ACTIVATION_DECAY,
    threshold: float = DEFAULT_ACTIVATION_THRESHOLD,
    max_hops: int = DEFAULT_ACTIVATION_MAX_HOPS,
) -> list[tuple[int, float]]:
    """Weighted, scored BFS: ``activation(neighbor) = activation(parent) *
    decay * (relationship.weight / max_weight)``, thresholded and bounded to
    ``max_hops``. Multiple paths to the same node keep the strongest
    (``MAX``) activation. Returns ``[(entity_id, activation)]`` sorted
    highest-activation-first, ``[]`` for an empty seed set."""
    if not seed_scores:
        return []

    max_weight_row = conn.execute("SELECT MAX(weight) AS m FROM relationships").fetchone()
    max_weight = float(max_weight_row["m"]) if max_weight_row and max_weight_row["m"] else 1.0
    max_weight = max_weight or 1.0

    seed_values = ", ".join("(?, ?, 0)" for _ in seed_scores)
    seed_params: list[object] = []
    for entity_id, score in seed_scores.items():
        seed_params.extend([entity_id, score])

    sql = f"""
        WITH RECURSIVE spread(entity_id, activation, hop) AS (
            SELECT * FROM (VALUES {seed_values})
            UNION ALL
            SELECT
                CASE WHEN r.source_id = s.entity_id THEN r.target_id ELSE r.source_id END,
                s.activation * ? * (r.weight / ?),
                s.hop + 1
            FROM relationships r
            JOIN spread s ON (r.source_id = s.entity_id OR r.target_id = s.entity_id)
            WHERE s.hop < ?
              AND s.activation * ? * (r.weight / ?) >= ?
        )
        SELECT entity_id, MAX(activation) AS activation
        FROM spread
        GROUP BY entity_id
        HAVING activation >= ?
        ORDER BY activation DESC, entity_id ASC
    """
    params: list[object] = [
        *seed_params,
        decay, max_weight, max_hops, decay, max_weight, threshold,
        threshold,
    ]
    rows = conn.execute(sql, params).fetchall()
    return [(int(row["entity_id"]), float(row["activation"])) for row in rows]


# ---------------------------------------------------------------------------
# Prompted strict-JSON: graph-context answer synthesis (LOCAL / activation)
# ---------------------------------------------------------------------------


def build_graph_answer_prompt(question: str, context_text: str, *, mode: str) -> tuple[str, str]:
    system = (
        f"You are the {mode} retrieval mode of Mythic Proportion's GraphRAG query "
        "engine. Answer the question using ONLY the supplied graph context -- "
        "never invent facts that aren't grounded in it. Output ONLY a single "
        'top-level JSON object: {"answer": "<answer text>", "citations": '
        '["<entity or report title>", ...]}. No prose, no markdown code fences.'
    )
    user = f"Graph context:\n{context_text or '(no context retrieved)'}\n\nQuestion:\n{question}"
    return system, user


def parse_graph_answer_response(raw: str) -> tuple[str, list[str]]:
    match = _JSON_OBJECT_RE.search(raw)
    if match is None:
        return raw.strip(), []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return raw.strip(), []
    if not isinstance(data, dict):
        return raw.strip(), []
    answer = str(data.get("answer", "")).strip()
    citations = [str(c) for c in data.get("citations", []) if isinstance(c, str) and c.strip()]
    return (answer or raw.strip()), citations


def local_search(
    conn: sqlite3.Connection,
    question: str,
    *,
    client: ExtractionClient,
    cache: LlmCache | None = None,
    model: str = "mock",
    embedder: Embedder | None = None,
    vec_active: bool = False,
    k_seeds: int = DEFAULT_SEED_LIMIT,
    hops: int = DEFAULT_LOCAL_HOPS,
    max_context_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
) -> ModeResult:
    """LOCAL: sqlite-vec/FTS5 seed entities -> recursive-CTE neighbor expand
    -> text_units/claims -> token-budget-ranked LLM answer."""
    store = GraphStore(conn)
    cache = cache if cache is not None else LlmCache(conn)

    seed_scores = select_seed_entities(conn, question, embedder=embedder, vec_active=vec_active, limit=k_seeds)
    expanded_ids = local_expand(conn, list(seed_scores), hops=hops)
    context_text, titles = _gather_context(store, expanded_ids, max_chars=max_context_chars)

    if not expanded_ids:
        return ModeResult(
            text="No graph entities matched this question yet.", citations=[], mode="local", entity_ids=[]
        )

    system, user = build_graph_answer_prompt(question, context_text, mode="local")
    response, _hit = read_through_complete(client, cache, system=system, user=user, model=model)
    answer, citations = parse_graph_answer_response(response)
    return ModeResult(
        text=answer, citations=citations or titles, mode="local", used_llm=True, entity_ids=expanded_ids
    )


def activation_search(
    conn: sqlite3.Connection,
    question: str,
    *,
    client: ExtractionClient,
    cache: LlmCache | None = None,
    model: str = "mock",
    embedder: Embedder | None = None,
    vec_active: bool = False,
    k_seeds: int = DEFAULT_SEED_LIMIT,
    decay: float = DEFAULT_ACTIVATION_DECAY,
    threshold: float = DEFAULT_ACTIVATION_THRESHOLD,
    max_hops: int = DEFAULT_ACTIVATION_MAX_HOPS,
    top_n: int = DEFAULT_GLOBAL_TOP_N,
    max_context_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
) -> ModeResult:
    """spreading-activation: FTS5(BM25) UNION sqlite-vec seeds -> weighted
    scored BFS (:func:`spreading_activation`) -> token-budget-ranked LLM
    answer over the top-``top_n`` activated entities."""
    store = GraphStore(conn)
    cache = cache if cache is not None else LlmCache(conn)

    seed_scores = select_seed_entities(conn, question, embedder=embedder, vec_active=vec_active, limit=k_seeds)
    activated = spreading_activation(conn, seed_scores, decay=decay, threshold=threshold, max_hops=max_hops)
    top_ids = [entity_id for entity_id, _score in activated[:top_n]]
    context_text, titles = _gather_context(store, top_ids, max_chars=max_context_chars)

    if not top_ids:
        return ModeResult(
            text="No graph entities matched this question yet.", citations=[], mode="activation", entity_ids=[]
        )

    system, user = build_graph_answer_prompt(question, context_text, mode="spreading-activation")
    response, _hit = read_through_complete(client, cache, system=system, user=user, model=model)
    answer, citations = parse_graph_answer_response(response)
    return ModeResult(
        text=answer, citations=citations or titles, mode="activation", used_llm=True, entity_ids=top_ids
    )


# ---------------------------------------------------------------------------
# GLOBAL: map-reduce over community_reports
# ---------------------------------------------------------------------------


def build_global_map_prompt(question: str, reports_batch: list[dict]) -> tuple[str, str]:
    system = (
        "You are the map step of GLOBAL community-report search. Given a batch "
        "of community reports and a question, extract rated key points "
        "relevant to the question. Output ONLY a single top-level JSON array: "
        '[{"point": "<key point text>", "score": <float 0-10 relevance>}, ...]. '
        "Output [] if nothing in these reports is relevant. No prose, no fences."
    )
    reports_block = (
        "\n\n".join(
            f"### {r['title']} (level {r['level']}, cluster {r['cluster']})\n{r['summary']}"
            for r in reports_batch
        )
        or "(no reports)"
    )
    user = f"Community reports:\n{reports_block}\n\nQuestion:\n{question}"
    return system, user


def parse_rated_points(raw: str) -> list[RatedPoint]:
    match = _JSON_ARRAY_RE.search(raw)
    if match is None:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    points: list[RatedPoint] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text = str(item.get("point", "")).strip()
        if not text:
            continue
        try:
            score = float(item.get("score", 0))
        except (TypeError, ValueError):
            score = 0.0
        points.append(RatedPoint(point=text, score=score))
    return points


def build_global_reduce_prompt(question: str, top_points: list[RatedPoint]) -> tuple[str, str]:
    system = (
        "You are the reduce step of GLOBAL community-report search. Given the "
        "highest-scoring key points gathered across every community-report "
        "batch, synthesize one final answer to the question. Output ONLY a "
        'single top-level JSON object: {"answer": "<final answer>"}. No '
        "prose, no fences."
    )
    points_block = "\n".join(f"- ({point.score:.1f}) {point.point}" for point in top_points) or (
        "(no key points found)"
    )
    user = f"Key points:\n{points_block}\n\nQuestion:\n{question}"
    return system, user


def global_search(
    conn: sqlite3.Connection,
    question: str,
    *,
    client: ExtractionClient,
    cache: LlmCache | None = None,
    model: str = "mock",
    level: int | None = None,
    batch_size: int = DEFAULT_GLOBAL_BATCH_SIZE,
    top_n: int = DEFAULT_GLOBAL_TOP_N,
) -> ModeResult:
    """GLOBAL: map-reduce over ``community_reports`` at one level -- map each
    batch of reports into LLM-rated key points, reduce the top-scored points
    into one final answer."""
    store = GraphStore(conn)
    cache = cache if cache is not None else LlmCache(conn)
    resolved_level = level if level is not None else store.max_community_level()
    reports = store.list_community_reports(level=resolved_level)

    if not reports:
        return ModeResult(
            text="No community reports are available yet -- run community/report generation first.",
            citations=[],
            mode="global",
            entity_ids=[],
        )

    all_points: list[RatedPoint] = []
    for start in range(0, len(reports), batch_size):
        batch = reports[start : start + batch_size]
        map_system, map_user = build_global_map_prompt(question, batch)
        map_response, _hit = read_through_complete(client, cache, system=map_system, user=map_user, model=model)
        all_points.extend(parse_rated_points(map_response))

    all_points.sort(key=lambda point: point.score, reverse=True)
    top_points = all_points[:top_n]

    reduce_system, reduce_user = build_global_reduce_prompt(question, top_points)
    reduce_response, _hit = read_through_complete(
        client, cache, system=reduce_system, user=reduce_user, model=model
    )
    answer = reduce_response.strip()
    match = _JSON_OBJECT_RE.search(reduce_response)
    if match is not None:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, dict) and str(data.get("answer", "")).strip():
                answer = str(data["answer"]).strip()
        except json.JSONDecodeError:
            pass

    citations = [r["title"] for r in reports if r["title"]]
    return ModeResult(
        text=answer, citations=citations, mode="global", used_llm=True, entity_ids=[], points=top_points
    )


# ---------------------------------------------------------------------------
# DRIFT: primer over reports -> per-follow-up LOCAL loop -> aggregate
# ---------------------------------------------------------------------------


def build_drift_primer_prompt(question: str, reports: list[dict]) -> tuple[str, str]:
    system = (
        "You are the DRIFT primer step: given a broad set of community "
        "reports and a question, write a draft answer plus a short list of "
        "follow-up questions worth investigating locally. Output ONLY a "
        'single top-level JSON object: {"draft": "<draft answer>", '
        '"follow_ups": ["<question>", ...]}. No prose, no fences.'
    )
    reports_block = "\n\n".join(f"### {r['title']}\n{r['summary']}" for r in reports) or "(no reports)"
    user = f"Community reports:\n{reports_block}\n\nQuestion:\n{question}"
    return system, user


def parse_drift_primer(raw: str) -> tuple[str, list[str]]:
    match = _JSON_OBJECT_RE.search(raw)
    if match is None:
        return raw.strip(), []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return raw.strip(), []
    if not isinstance(data, dict):
        return raw.strip(), []
    draft = str(data.get("draft", "")).strip()
    follow_ups = [str(f).strip() for f in data.get("follow_ups", []) if str(f).strip()]
    return (draft or raw.strip()), follow_ups


def _select_top_reports(
    store: GraphStore, question: str, *, embedder: Embedder | None, vec_active: bool, limit: int
) -> list[dict]:
    reports = store.list_community_reports()
    if not reports:
        return []
    if embedder is None:
        query_tokens = {token for token in question.lower().split() if token}

        def _lexical_score(report: dict) -> int:
            haystack = f"{report['title']} {report['summary']}".lower()
            return sum(1 for token in query_tokens if token in haystack)

        return sorted(reports, key=_lexical_score, reverse=True)[:limit]

    query_vector = l2_normalize(embedder.embed([question])[0])
    report_ids = [report["id"] for report in reports]
    scores = store.report_vector_scores(query_vector, report_ids, vec_active=vec_active)
    ranked = sorted(reports, key=lambda report: scores.get(report["id"], 0.0), reverse=True)
    return ranked[:limit]


def drift_search(
    conn: sqlite3.Connection,
    question: str,
    *,
    client: ExtractionClient,
    cache: LlmCache | None = None,
    model: str = "mock",
    embedder: Embedder | None = None,
    vec_active: bool = False,
    k_reports: int = DEFAULT_DRIFT_K_REPORTS,
    max_follow_ups: int = DEFAULT_DRIFT_MAX_FOLLOW_UPS,
    hops: int = 1,
) -> ModeResult:
    """DRIFT: a primer draft + follow-up questions over ``community_reports``
    (broad), then each follow-up re-runs the LOCAL flow (narrow), aggregated
    into one Q/A tree."""
    store = GraphStore(conn)
    cache = cache if cache is not None else LlmCache(conn)

    top_reports = _select_top_reports(store, question, embedder=embedder, vec_active=vec_active, limit=k_reports)
    if not top_reports:
        return ModeResult(
            text="No community reports are available yet -- run community/report generation first.",
            citations=[],
            mode="drift",
            entity_ids=[],
        )

    primer_system, primer_user = build_drift_primer_prompt(question, top_reports)
    primer_response, _hit = read_through_complete(
        client, cache, system=primer_system, user=primer_user, model=model
    )
    draft, follow_ups = parse_drift_primer(primer_response)

    qa_tree: list[dict[str, str]] = []
    citations: list[str] = [report["title"] for report in top_reports]
    for follow_up in follow_ups[:max_follow_ups]:
        sub_result = local_search(
            conn,
            follow_up,
            client=client,
            cache=cache,
            model=model,
            embedder=embedder,
            vec_active=vec_active,
            hops=hops,
        )
        qa_tree.append({"question": follow_up, "answer": sub_result.text})
        citations.extend(sub_result.citations)

    qa_text = "\n".join(f"Q: {qa['question']}\nA: {qa['answer']}" for qa in qa_tree)
    final_text = draft if not qa_tree else f"{draft}\n\n{qa_text}"

    seen: set[str] = set()
    deduped_citations: list[str] = []
    for citation in citations:
        if citation not in seen:
            seen.add(citation)
            deduped_citations.append(citation)

    return ModeResult(
        text=final_text,
        citations=deduped_citations,
        mode="drift",
        used_llm=True,
        entity_ids=[],
        qa_tree=qa_tree,
    )
