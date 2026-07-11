"""Tests for hierarchical Leiden community detection + community-report
generation (Phase 4). Every test here is deterministic and network-free:
Leiden itself is a real, pinned-seed algorithm (not an LLM call), and every
LLM call in report generation goes through
:class:`~mythic_proportion.graph.extract.FakeExtractionClient`.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mythic_proportion.graph.cache import LlmCache
from mythic_proportion.graph.communities import (
    build_weighted_edge_list,
    compute_communities,
    run_hierarchical_leiden,
)
from mythic_proportion.graph.extract import FakeExtractionClient
from mythic_proportion.graph.reports import (
    build_community_report_prompt,
    generate_community_reports,
    parse_community_report_response,
)
from mythic_proportion.graph.store import GraphStore

_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "src" / "mythic_proportion" / "index" / "schema.sql"

try:
    import graspologic  # noqa: F401

    _HAS_GRASPOLOGIC = True
except ImportError:
    _HAS_GRASPOLOGIC = False


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


def _seed_two_cluster_graph(conn: sqlite3.Connection) -> GraphStore:
    """Two loosely-connected dense clusters -- {A,B,C} and {D,E,F} -- joined
    by one weak bridge edge (C-D)."""
    store = GraphStore(conn)
    ids = {name: store.upsert_entity(name, "CONCEPT", f"{name} description") for name in "ABCDEF"}
    store.upsert_relationship(ids["A"], ids["B"], "related", "a-b", 8.0)
    store.upsert_relationship(ids["B"], ids["C"], "related", "b-c", 8.0)
    store.upsert_relationship(ids["A"], ids["C"], "related", "a-c", 8.0)
    store.upsert_relationship(ids["D"], ids["E"], "related", "d-e", 8.0)
    store.upsert_relationship(ids["E"], ids["F"], "related", "e-f", 8.0)
    store.upsert_relationship(ids["D"], ids["F"], "related", "d-f", 8.0)
    store.upsert_relationship(ids["C"], ids["D"], "related", "bridge", 0.1)
    return store


# ---------------------------------------------------------------------------
# build_weighted_edge_list
# ---------------------------------------------------------------------------


def test_build_weighted_edge_list_aggregates_multi_typed_edges_into_one_undirected_pair() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    a = store.upsert_entity("A", "CONCEPT", "")
    b = store.upsert_entity("B", "CONCEPT", "")
    # Two distinct relationship *types* between the same pair -- both should
    # collapse into one undirected (a, b) edge, weights summed.
    store.upsert_relationship(a, b, "related", "", 3.0)
    store.upsert_relationship(a, b, "mentions", "", 2.0)
    store.upsert_relationship(b, a, "cites", "", 1.0)  # reverse direction too

    edges = build_weighted_edge_list(conn)
    assert len(edges) == 1
    x, y, weight = edges[0]
    assert {x, y} == {a, b}
    assert weight == pytest.approx(6.0)


def test_build_weighted_edge_list_ignores_self_loops() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    a = store.upsert_entity("A", "CONCEPT", "")
    store.upsert_relationship(a, a, "related", "self", 5.0)
    assert build_weighted_edge_list(conn) == []


# ---------------------------------------------------------------------------
# run_hierarchical_leiden / compute_communities -- stability across re-runs
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _HAS_GRASPOLOGIC, reason="graspologic (or a leidenalg fallback) is not installed")
def test_run_hierarchical_leiden_is_stable_across_identical_re_runs() -> None:
    conn = _memory_conn()
    _seed_two_cluster_graph(conn)
    edges = build_weighted_edge_list(conn)

    first, backend_first = run_hierarchical_leiden(edges, random_seed=42)
    second, backend_second = run_hierarchical_leiden(edges, random_seed=42)

    assert backend_first == backend_second
    assert first == second  # identical CommunityAssignment tuples, in order


@pytest.mark.skipif(not _HAS_GRASPOLOGIC, reason="graspologic (or a leidenalg fallback) is not installed")
def test_run_hierarchical_leiden_separates_the_two_planted_clusters() -> None:
    conn = _memory_conn()
    _seed_two_cluster_graph(conn)
    edges = build_weighted_edge_list(conn)
    assignments, _backend = run_hierarchical_leiden(edges, random_seed=42)

    entity_ids = {
        row["title"]: row["id"] for row in conn.execute("SELECT id, title FROM entities")
    }
    cluster_of: dict[int, int] = {}
    for a in assignments:
        if a.level == 0:  # coarsest level -- exactly what separates the two planted clusters
            cluster_of[a.entity_id] = a.cluster

    abc_clusters = {cluster_of[entity_ids[name]] for name in "ABC"}
    def_clusters = {cluster_of[entity_ids[name]] for name in "DEF"}
    assert len(abc_clusters) == 1  # A, B, C land in the same cluster
    assert len(def_clusters) == 1  # D, E, F land in the same (different) cluster
    assert abc_clusters != def_clusters


@pytest.mark.skipif(not _HAS_GRASPOLOGIC, reason="graspologic (or a leidenalg fallback) is not installed")
def test_compute_communities_persists_stable_ids_and_is_transactional_replace(tmp_path: Path) -> None:
    conn = _memory_conn()
    _seed_two_cluster_graph(conn)

    first_report = compute_communities(conn, random_seed=42)
    first_rows = list(conn.execute("SELECT level, cluster, parent_cluster, entity_id FROM communities"))

    second_report = compute_communities(conn, random_seed=42)
    second_rows = list(conn.execute("SELECT level, cluster, parent_cluster, entity_id FROM communities"))

    assert first_report.rows_written == second_report.rows_written
    assert [tuple(r) for r in first_rows] == [tuple(r) for r in second_rows]  # stable community IDs
    assert first_report.entities_clustered == 6
    assert first_report.entities_isolated == 0


@pytest.mark.skipif(not _HAS_GRASPOLOGIC, reason="graspologic (or a leidenalg fallback) is not installed")
def test_compute_communities_assigns_isolated_entities_their_own_singleton_community() -> None:
    conn = _memory_conn()
    store = _seed_two_cluster_graph(conn)
    lonely_id = store.upsert_entity("LONELY", "CONCEPT", "no relationships at all")

    report = compute_communities(conn, random_seed=42)
    assert report.entities_isolated == 1

    row = conn.execute("SELECT level, cluster FROM communities WHERE entity_id = ?", (lonely_id,)).fetchone()
    assert row is not None
    assert row["level"] == 0


def test_run_hierarchical_leiden_returns_empty_for_no_edges() -> None:
    assignments, backend = run_hierarchical_leiden([], random_seed=1)
    assert assignments == []
    assert backend == "none"


# ---------------------------------------------------------------------------
# Community-report generation -- prompt/parse + idempotent cache-backed reruns
# ---------------------------------------------------------------------------


def test_parse_community_report_response_well_formed_json() -> None:
    raw = '{"title": "The Founders", "summary": "A tight-knit group.", "rating": 7.5}'
    title, summary, rating = parse_community_report_response(raw)
    assert title == "The Founders"
    assert summary == "A tight-knit group."
    assert rating == 7.5


def test_parse_community_report_response_degrades_gracefully_on_malformed_output() -> None:
    title, summary, rating = parse_community_report_response("not json at all")
    assert title == "Untitled community"
    assert summary == ""
    assert rating == 5.0


def test_build_community_report_prompt_includes_members_and_relationships() -> None:
    entities = [{"title": "A", "type": "CONCEPT", "description": "desc-a"}]
    relationships = [{"source_id": 1, "target_id": 2, "type": "related", "description": "d", "weight": 3.0}]
    _system, user = build_community_report_prompt(
        level=0, cluster=1, entities=entities, relationships=relationships
    )
    assert "A (CONCEPT)" in user
    assert "desc-a" in user
    assert "related" in user


def _seed_one_community(conn: sqlite3.Connection) -> None:
    store = GraphStore(conn)
    a = store.upsert_entity("Ada Lovelace", "PERSON", "a mathematician")
    b = store.upsert_entity("Charles Babbage", "PERSON", "an inventor")
    store.upsert_relationship(a, b, "related", "collaborated", 5.0)
    store.replace_communities([(0, 0, None, a), (0, 0, None, b)])


def test_generate_community_reports_writes_one_row_per_community() -> None:
    conn = _memory_conn()
    _seed_one_community(conn)
    client = FakeExtractionClient('{"title": "Computing Pioneers", "summary": "Ada and Charles.", "rating": 8}')

    report = generate_community_reports(conn, client=client, model="mock")

    assert report.reports_written == 1
    assert report.llm_calls == 1
    row = conn.execute("SELECT title, summary, rating FROM community_reports WHERE level=0 AND cluster=0").fetchone()
    assert row["title"] == "Computing Pioneers"
    assert row["rating"] == 8.0


def test_generate_community_reports_is_idempotent_cache_hit_on_unchanged_community() -> None:
    conn = _memory_conn()
    _seed_one_community(conn)
    client = FakeExtractionClient('{"title": "Computing Pioneers", "summary": "Ada and Charles.", "rating": 8}')
    cache = LlmCache(conn)

    first = generate_community_reports(conn, client=client, cache=cache, model="mock")
    first_row = dict(
        conn.execute("SELECT title, summary, rating FROM community_reports WHERE level=0 AND cluster=0").fetchone()
    )

    second = generate_community_reports(conn, client=client, cache=cache, model="mock")
    second_row = dict(
        conn.execute("SELECT title, summary, rating FROM community_reports WHERE level=0 AND cluster=0").fetchone()
    )

    assert first.llm_calls == 1
    assert second.llm_calls == 0  # unchanged community -> pure cache hit, zero new LLM calls
    assert second.cache_hits == 1
    assert first_row == second_row  # identical report content across reruns
    assert len(client.calls) == 1  # the client itself was invoked exactly once total
