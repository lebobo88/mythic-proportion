"""Tests for the four GraphRAG query modes (Phase 4): global / local / DRIFT
/ spreading-activation. Every LLM call here uses
:class:`~mythic_proportion.graph.extract.FakeExtractionClient` -- no
network, no ``AUTHHUB_API_KEY`` required.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.extract import FakeExtractionClient
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.query.modes import (
    RatedPoint,
    build_global_map_prompt,
    drift_search,
    global_search,
    local_expand,
    local_search,
    parse_drift_primer,
    parse_graph_answer_response,
    parse_rated_points,
    select_seed_entities,
    spreading_activation,
)

_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "src" / "mythic_proportion" / "index" / "schema.sql"


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


# ---------------------------------------------------------------------------
# LOCAL: recursive-CTE N-hop neighbor expansion
# ---------------------------------------------------------------------------


def _seed_chain_graph(conn: sqlite3.Connection) -> dict[str, int]:
    """A -- B -- C -- D chain, no shortcut edges."""
    store = GraphStore(conn)
    ids = {name: store.upsert_entity(name, "CONCEPT", f"{name} desc") for name in "ABCD"}
    store.upsert_relationship(ids["A"], ids["B"], "related", "", 1.0)
    store.upsert_relationship(ids["B"], ids["C"], "related", "", 1.0)
    store.upsert_relationship(ids["C"], ids["D"], "related", "", 1.0)
    return ids


def test_local_expand_returns_correct_n_hop_neighborhood() -> None:
    conn = _memory_conn()
    ids = _seed_chain_graph(conn)

    assert local_expand(conn, [ids["A"]], hops=0) == [ids["A"]]
    assert local_expand(conn, [ids["A"]], hops=1) == [ids["A"], ids["B"]]
    assert local_expand(conn, [ids["A"]], hops=2) == [ids["A"], ids["B"], ids["C"]]
    assert local_expand(conn, [ids["A"]], hops=3) == [ids["A"], ids["B"], ids["C"], ids["D"]]
    # A 4th hop can't reach anything new -- D has no further edges.
    assert local_expand(conn, [ids["A"]], hops=10) == [ids["A"], ids["B"], ids["C"], ids["D"]]


def test_local_expand_empty_seed_list_returns_empty() -> None:
    conn = _memory_conn()
    _seed_chain_graph(conn)
    assert local_expand(conn, [], hops=2) == []


def test_local_expand_multiple_seeds_union_their_neighborhoods() -> None:
    conn = _memory_conn()
    ids = _seed_chain_graph(conn)
    # Seeding from both ends at hop=0 should just be the two seeds themselves.
    assert set(local_expand(conn, [ids["A"], ids["D"]], hops=0)) == {ids["A"], ids["D"]}


def test_local_search_answers_from_the_expanded_neighborhood() -> None:
    conn = _memory_conn()
    ids = _seed_chain_graph(conn)
    response = '{"answer": "A connects to B and C.", "citations": ["A", "B"]}'
    client = FakeExtractionClient(response)

    result = local_search(conn, "A", client=client, model="mock", embedder=None, hops=2, k_seeds=5)

    assert result.mode == "local"
    assert result.used_llm is True
    assert result.text == "A connects to B and C."
    assert result.citations == ["A", "B"]
    assert set(result.entity_ids) == {ids["A"], ids["B"], ids["C"]}


def test_local_search_with_no_matching_seeds_returns_empty_result_without_llm_call() -> None:
    conn = _memory_conn()
    _seed_chain_graph(conn)
    client = FakeExtractionClient("should never be called")

    result = local_search(conn, "totally unrelated gibberish query zzy", client=client, embedder=None)

    assert result.entity_ids == []
    assert result.used_llm is False
    assert client.calls == []


# ---------------------------------------------------------------------------
# Seed selection (FTS5 BM25 [union sqlite-vec cosine])
# ---------------------------------------------------------------------------


def test_select_seed_entities_bm25_only_finds_lexical_match() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    store.upsert_entity("Analytical Engine", "CONCEPT", "an early mechanical computer")
    store.upsert_entity("Gardening", "CONCEPT", "watering tomatoes")

    seeds = select_seed_entities(conn, "analytical engine computer", embedder=None, vec_active=False, limit=5)
    assert seeds  # at least one hit
    top_id = max(seeds, key=lambda eid: seeds[eid])
    row = conn.execute("SELECT title FROM entities WHERE id = ?", (top_id,)).fetchone()
    assert row["title"] == "Analytical Engine"


def test_select_seed_entities_empty_query_returns_empty() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    store.upsert_entity("A", "CONCEPT", "")
    assert select_seed_entities(conn, "   ", embedder=None, vec_active=False) == {}


# ---------------------------------------------------------------------------
# Spreading-activation: weighted scored BFS ranks a multi-hop answer above a
# lexical-only distractor
# ---------------------------------------------------------------------------


def test_spreading_activation_ranks_planted_multi_hop_answer_above_lexical_distractor() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)

    # A weak, purely-lexical "distractor" match with no useful onward edges.
    distractor_id = store.upsert_entity("Spaceship Trivia", "CONCEPT", "an unrelated stray mention")
    # A strongly-relevant seed that is itself only loosely on-topic, but
    # multi-hop-connects (via strong edges) to the true planted answer.
    seed_id = store.upsert_entity("Rocket Propulsion", "CONCEPT", "spaceship propulsion basics")
    mid_id = store.upsert_entity("Orbital Mechanics", "CONCEPT", "intermediate hop")
    answer_id = store.upsert_entity("Planted Multi-Hop Answer", "CONCEPT", "the true answer, two hops away")

    store.upsert_relationship(seed_id, mid_id, "related", "", 10.0)
    store.upsert_relationship(mid_id, answer_id, "related", "", 10.0)

    # Seed scores as if `select_seed_entities` had already blended
    # lexical+vector similarity: the distractor scores low (barely
    # relevant), the true seed scores high (strongly relevant).
    seed_scores = {distractor_id: 0.05, seed_id: 1.0}

    activated = spreading_activation(conn, seed_scores, decay=0.9, threshold=0.01, max_hops=4)
    activation_by_id = dict(activated)

    assert answer_id in activation_by_id
    assert distractor_id in activation_by_id
    assert activation_by_id[answer_id] > activation_by_id[distractor_id]

    # And the ranked order (highest first) places the true answer above the
    # lexical distractor.
    ranked_ids = [entity_id for entity_id, _score in activated]
    assert ranked_ids.index(answer_id) < ranked_ids.index(distractor_id)


def test_spreading_activation_respects_threshold_and_max_hops() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    a = store.upsert_entity("A", "CONCEPT", "")
    b = store.upsert_entity("B", "CONCEPT", "")
    c = store.upsert_entity("C", "CONCEPT", "")
    store.upsert_relationship(a, b, "related", "", 1.0)
    store.upsert_relationship(b, c, "related", "", 1.0)

    # decay so aggressive that hop 2 falls below threshold.
    activated = spreading_activation(conn, {a: 1.0}, decay=0.1, threshold=0.05, max_hops=4)
    ids = {entity_id for entity_id, _score in activated}
    assert a in ids
    assert b in ids
    assert c not in ids  # 1.0 * 0.1 * 0.1 = 0.01 < threshold


def test_spreading_activation_empty_seeds_returns_empty() -> None:
    conn = _memory_conn()
    assert spreading_activation(conn, {}) == []


# ---------------------------------------------------------------------------
# GLOBAL: map-reduce over community_reports
# ---------------------------------------------------------------------------


def _seed_community_reports(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO community_reports(level, cluster, title, summary, full_content, rating) "
        "VALUES (0, 0, 'Founders', 'The founding members.', '', 8.0)"
    )
    conn.execute(
        "INSERT INTO community_reports(level, cluster, title, summary, full_content, rating) "
        "VALUES (0, 1, 'Gardeners', 'Tomato enthusiasts.', '', 3.0)"
    )
    conn.commit()


def test_parse_rated_points_well_formed_json_array() -> None:
    raw = '[{"point": "founders collaborated", "score": 9}, {"point": "irrelevant", "score": 1}]'
    points = parse_rated_points(raw)
    assert points == [RatedPoint(point="founders collaborated", score=9.0), RatedPoint(point="irrelevant", score=1.0)]


def test_parse_rated_points_malformed_returns_empty() -> None:
    assert parse_rated_points("not json") == []


def test_build_global_map_prompt_includes_report_titles() -> None:
    reports = [{"title": "Founders", "level": 0, "cluster": 0, "summary": "s"}]
    _system, user = build_global_map_prompt("who founded this?", reports)
    assert "Founders" in user


def test_global_search_map_reduce_aggregates_report_points_into_one_answer() -> None:
    conn = _memory_conn()
    _seed_community_reports(conn)

    def fixture(system: str, user: str, idx: int) -> str:
        if "map step" in system:
            if "Founders" in user:
                return '[{"point": "The founders collaborated closely.", "score": 9.5}]'
            return '[{"point": "Tomatoes need daily watering.", "score": 1.0}]'
        # reduce step
        assert "founders collaborated" in user or "9.5" in user
        return '{"answer": "The founders collaborated closely on the project."}'

    client = FakeExtractionClient(fixture)
    result = global_search(conn, "Who founded this?", client=client, model="mock", batch_size=1)

    assert result.mode == "global"
    assert result.used_llm is True
    assert result.text == "The founders collaborated closely on the project."
    assert len(result.points) == 2
    # highest-scored point (the founders one) sorts first
    assert result.points[0].point == "The founders collaborated closely."
    assert set(result.citations) == {"Founders", "Gardeners"}


def test_global_search_with_no_reports_returns_placeholder_without_llm_call() -> None:
    conn = _memory_conn()
    client = FakeExtractionClient("should never be called")
    result = global_search(conn, "anything", client=client)
    assert result.used_llm is False
    assert client.calls == []


# ---------------------------------------------------------------------------
# DRIFT: primer -> per-follow-up LOCAL loop -> aggregated Q/A tree
# ---------------------------------------------------------------------------


def test_parse_drift_primer_well_formed_json() -> None:
    raw = '{"draft": "A broad answer.", "follow_ups": ["what about B?", "what about C?"]}'
    draft, follow_ups = parse_drift_primer(raw)
    assert draft == "A broad answer."
    assert follow_ups == ["what about B?", "what about C?"]


def test_drift_search_aggregates_primer_and_follow_up_answers() -> None:
    conn = _memory_conn()
    _seed_community_reports(conn)
    _seed_chain_graph(conn)

    def fixture(system: str, user: str, idx: int) -> str:
        if "DRIFT primer" in system:
            return '{"draft": "Broad draft answer.", "follow_ups": ["Tell me about A"]}'
        if "local retrieval mode" in system:
            return '{"answer": "A connects to B.", "citations": ["A"]}'
        return '{"answer": "fallback"}'

    client = FakeExtractionClient(fixture)
    result = drift_search(conn, "broad question", client=client, model="mock", embedder=None, max_follow_ups=2)

    assert result.mode == "drift"
    assert result.used_llm is True
    assert "Broad draft answer." in result.text
    assert "Tell me about A" in result.text
    assert "A connects to B." in result.text
    assert len(result.qa_tree) == 1
    assert result.qa_tree[0]["question"] == "Tell me about A"


def test_drift_search_with_no_reports_returns_placeholder_without_llm_call() -> None:
    conn = _memory_conn()
    client = FakeExtractionClient("should never be called")
    result = drift_search(conn, "anything", client=client, embedder=None)
    assert result.used_llm is False
    assert client.calls == []


# ---------------------------------------------------------------------------
# Graph-answer JSON parsing
# ---------------------------------------------------------------------------


def test_parse_graph_answer_response_well_formed() -> None:
    raw = '{"answer": "The answer.", "citations": ["A", "B"]}'
    answer, citations = parse_graph_answer_response(raw)
    assert answer == "The answer."
    assert citations == ["A", "B"]


def test_parse_graph_answer_response_malformed_falls_back_to_raw_text() -> None:
    answer, citations = parse_graph_answer_response("just some prose")
    assert answer == "just some prose"
    assert citations == []


# ---------------------------------------------------------------------------
# LlmCache reuse across modes -- calling local_search twice with the same
# question and unchanged graph state is a pure cache hit.
# ---------------------------------------------------------------------------


def test_local_search_is_cached_across_repeated_identical_calls() -> None:
    conn = _memory_conn()
    _seed_chain_graph(conn)
    cache = LlmCache(conn)
    client = FakeExtractionClient('{"answer": "cached answer", "citations": []}')

    local_search(conn, "A", client=client, cache=cache, model="mock", embedder=None)
    local_search(conn, "A", client=client, cache=cache, model="mock", embedder=None)

    assert len(client.calls) == 1  # second call was a pure cache hit
