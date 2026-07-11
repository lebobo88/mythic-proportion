"""Tests for the GraphRAG data layer (Phase 3).

Every test here uses :class:`~mythic_proportion.graph.extract.FakeExtractionClient`
-- deterministic, network-free -- so this suite never requires
``AUTHHUB_API_KEY`` or a real LLM provider. Covers: schema tables exist,
delimited-tuple parsing (well-formed / fenced / malformed-with-repair /
duplicate-title dedup), entity/relationship/claim extraction, the
``llm_cache`` read-through wrapper, and full-pipeline idempotency +
incremental re-index via :func:`mythic_proportion.graph.index.reindex_graph`.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.graph.cache import LlmCache, cache_key, read_through_complete
from mythic_proportion.graph.chunk import chunk_text
from mythic_proportion.graph.claims import extract_claims
from mythic_proportion.graph.extract import (
    ExtractedEntity,
    ExtractedRelationship,
    FakeExtractionClient,
    extract_entities_relationships,
)
from mythic_proportion.graph.index import reindex_graph
from mythic_proportion.graph.store import GraphStore, ensure_graph_vec_tables
from mythic_proportion.graph.tuples import (
    COMPLETION_DELIM,
    RECORD_DELIM,
    TUPLE_DELIM,
    normalize_entity_type,
    normalize_title,
    parse_tuple_records,
)
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.vault.init import init_vault

_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "src" / "mythic_proportion" / "index" / "schema.sql"


def _memory_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


def _entity_record(name: str, etype: str, desc: str) -> str:
    return f'("entity"{TUPLE_DELIM}{name}{TUPLE_DELIM}{etype}{TUPLE_DELIM}{desc})'


def _relationship_record(source: str, target: str, desc: str, strength: str = "7") -> str:
    return f'("relationship"{TUPLE_DELIM}{source}{TUPLE_DELIM}{target}{TUPLE_DELIM}{desc}{TUPLE_DELIM}{strength})'


def _claim_record(subject: str, obj: str, ctype: str, status: str, desc: str) -> str:
    return (
        f'("claim"{TUPLE_DELIM}{subject}{TUPLE_DELIM}{obj}{TUPLE_DELIM}{ctype}{TUPLE_DELIM}'
        f"{status}{TUPLE_DELIM}NONE{TUPLE_DELIM}NONE{TUPLE_DELIM}{desc})"
    )


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_schema_creates_all_graphrag_tables_and_coexists_with_pages() -> None:
    conn = _memory_conn()
    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    expected_graph_tables = {
        "entities",
        "relationships",
        "text_units",
        "text_unit_entities",
        "claims",
        "communities",
        "community_reports",
        "llm_cache",
    }
    expected_preexisting_tables = {"pages", "page_vectors", "meta"}
    assert expected_graph_tables <= tables
    assert expected_preexisting_tables <= tables


def test_schema_apply_is_idempotent() -> None:
    conn = _memory_conn()
    # Re-applying the same schema.sql on an already-initialized DB (exactly
    # what every `IndexStore.open()` call does) must not raise.
    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))


def test_communities_and_community_reports_tables_start_empty() -> None:
    """Phase 3 creates these tables but never populates them -- Phase 4 does."""
    conn = _memory_conn()
    assert conn.execute("SELECT COUNT(*) AS n FROM communities").fetchone()["n"] == 0
    assert conn.execute("SELECT COUNT(*) AS n FROM community_reports").fetchone()["n"] == 0


# ---------------------------------------------------------------------------
# Delimited-tuple parser
# ---------------------------------------------------------------------------


def test_parse_tuple_records_well_formed() -> None:
    raw = (
        _entity_record("Ada Lovelace", "PERSON", "a mathematician")
        + RECORD_DELIM
        + _relationship_record("Ada Lovelace", "Analytical Engine", "wrote notes on it", "8")
        + COMPLETION_DELIM
    )
    records = parse_tuple_records(raw)
    assert records == [
        ["entity", "Ada Lovelace", "PERSON", "a mathematician"],
        ["relationship", "Ada Lovelace", "Analytical Engine", "wrote notes on it", "8"],
    ]


def test_parse_tuple_records_survives_markdown_fence() -> None:
    raw = "```\n" + _entity_record("Ada Lovelace", "PERSON", "a mathematician") + COMPLETION_DELIM + "\n```"
    records = parse_tuple_records(raw)
    assert records == [["entity", "Ada Lovelace", "PERSON", "a mathematician"]]


def test_parse_tuple_records_survives_json_style_fence_label() -> None:
    raw = "```json\n" + _entity_record("Ada Lovelace", "PERSON", "desc") + COMPLETION_DELIM + "\n```"
    records = parse_tuple_records(raw)
    assert records[0][1] == "Ada Lovelace"


def test_parse_tuple_records_ignores_everything_after_completion_sentinel() -> None:
    raw = _entity_record("A", "CONCEPT", "d") + COMPLETION_DELIM + " some trailing chatter I should not see"
    records = parse_tuple_records(raw)
    assert records == [["entity", "A", "CONCEPT", "d"]]


def test_parse_tuple_records_returns_empty_for_pure_prose() -> None:
    # No parens/delimiters at all -- a model ignoring instructions entirely.
    assert parse_tuple_records("I found no entities in this text.") == []


def test_parse_tuple_records_survives_truncated_record() -> None:
    # Missing the closing paren -- a common truncation failure mode.
    raw = f'("entity"{TUPLE_DELIM}Ada Lovelace{TUPLE_DELIM}PERSON{TUPLE_DELIM}a mathematician'
    records = parse_tuple_records(raw)
    assert records
    assert records[0][:3] == ["entity", "Ada Lovelace", "PERSON"]


def test_parse_tuple_records_handles_record_delimiter_inside_parens() -> None:
    # "##" inside a description must not fracture that record (balanced scan).
    raw = _entity_record("Widget", "CONCEPT", "before ## after") + COMPLETION_DELIM
    records = parse_tuple_records(raw)
    assert len(records) == 1
    assert records[0][3] == "before ## after"


def test_normalize_title_dedups_case_and_whitespace_variants() -> None:
    assert normalize_title("  Apple Inc ") == normalize_title("APPLE INC") == "APPLE INC"


def test_normalize_entity_type_falls_back_to_other_for_unknown_type() -> None:
    assert normalize_entity_type("PERSON") == "PERSON"
    assert normalize_entity_type("spaceship") == "OTHER"


# ---------------------------------------------------------------------------
# llm_cache read-through wrapper
# ---------------------------------------------------------------------------


def test_cache_key_is_stable_and_input_sensitive() -> None:
    a = cache_key(system="sys", user="hello", model="mock")
    b = cache_key(system="sys", user="hello", model="mock")
    c = cache_key(system="sys", user="different", model="mock")
    assert a == b
    assert a != c


def test_read_through_complete_is_a_cache_hit_on_second_call() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    client = FakeExtractionClient("canned response")

    first, first_hit = read_through_complete(client, cache, system="s", user="u", model="mock")
    second, second_hit = read_through_complete(client, cache, system="s", user="u", model="mock")

    assert first == second == "canned response"
    assert first_hit is False
    assert second_hit is True
    assert len(client.calls) == 1  # only the miss reached the client


# ---------------------------------------------------------------------------
# Entity/relationship extraction
# ---------------------------------------------------------------------------


def test_extract_entities_relationships_known_fixture() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    response = (
        _entity_record("Ada Lovelace", "PERSON", "a mathematician")
        + RECORD_DELIM
        + _entity_record("Charles Babbage", "PERSON", "an inventor")
        + RECORD_DELIM
        + _relationship_record("Ada Lovelace", "Charles Babbage", "collaborated with", "9")
        + COMPLETION_DELIM
    )

    def fixture(system: str, user: str, idx: int) -> str:
        return COMPLETION_DELIM if "MANY entities" in user else response

    client = FakeExtractionClient(fixture)
    entities, relationships, calls = extract_entities_relationships(
        "Ada Lovelace collaborated with Charles Babbage.", client=client, cache=cache, max_gleanings=1
    )

    assert entities == [
        ExtractedEntity(title="ADA LOVELACE", type="PERSON", description="a mathematician"),
        ExtractedEntity(title="CHARLES BABBAGE", type="PERSON", description="an inventor"),
    ]
    assert relationships == [
        ExtractedRelationship(
            source="ADA LOVELACE", target="CHARLES BABBAGE", description="collaborated with", weight=9.0
        )
    ]
    assert calls == 2  # one extraction call + one gleaning-check call


def test_extract_entities_relationships_dedups_duplicate_titles_within_one_chunk() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    response = (
        _entity_record("Apple Inc", "ORGANIZATION", "a company")
        + RECORD_DELIM
        + _entity_record("APPLE INC ", "ORGANIZATION", "duplicate mention")
        + COMPLETION_DELIM
    )
    client = FakeExtractionClient(lambda s, u, i: response)

    entities, _relationships, _calls = extract_entities_relationships(
        "Apple Inc text", client=client, cache=cache, max_gleanings=0
    )
    assert len(entities) == 1
    assert entities[0].title == "APPLE INC"


def test_extract_entities_relationships_recovers_via_one_repair_round_trip() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    malformed = "not a tuple at all, just prose describing entities"
    repaired = _entity_record("Repaired Entity", "CONCEPT", "recovered") + COMPLETION_DELIM

    def fixture(system: str, user: str, idx: int) -> str:
        if "could not be parsed" in user:
            return repaired
        if "MANY entities" in user:
            return COMPLETION_DELIM
        return malformed

    client = FakeExtractionClient(fixture)
    entities, _relationships, calls = extract_entities_relationships(
        "some text", client=client, cache=cache, max_gleanings=0
    )
    assert entities == [ExtractedEntity(title="REPAIRED ENTITY", type="CONCEPT", description="recovered")]
    assert calls == 2  # initial (malformed) + one repair round-trip


def test_extract_entities_relationships_skips_chunk_on_persistent_parse_failure() -> None:
    """Repair also fails -> degrade to empty, never raise (skip-not-abort)."""
    conn = _memory_conn()
    cache = LlmCache(conn)
    client = FakeExtractionClient("still not parseable, even after repair")

    entities, relationships, _calls = extract_entities_relationships(
        "some text", client=client, cache=cache, max_gleanings=0
    )
    assert entities == []
    assert relationships == []


def test_extract_entities_relationships_gleaning_loop_adds_missed_entities() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    first_pass = _entity_record("First Entity", "CONCEPT", "found first") + COMPLETION_DELIM
    glean_pass = _entity_record("Missed Entity", "CONCEPT", "found on gleaning") + COMPLETION_DELIM

    def fixture(system: str, user: str, idx: int) -> str:
        return glean_pass if "MANY entities" in user else first_pass

    client = FakeExtractionClient(fixture)
    entities, _relationships, calls = extract_entities_relationships(
        "some text", client=client, cache=cache, max_gleanings=1
    )
    titles = {e.title for e in entities}
    assert titles == {"FIRST ENTITY", "MISSED ENTITY"}
    assert calls == 2


def test_extract_entities_relationships_unresolved_relationship_target_still_parses() -> None:
    """A relationship tuple pointing at a title with no matching entity tuple
    in the *same* response is parsed here; the orchestrator (graph.index)
    is responsible for skipping it rather than inventing an entity."""
    conn = _memory_conn()
    cache = LlmCache(conn)
    response = _relationship_record("Known", "Unknown Elsewhere", "mentions", "5") + COMPLETION_DELIM
    client = FakeExtractionClient(lambda s, u, i: response)

    _entities, relationships, _calls = extract_entities_relationships(
        "text", client=client, cache=cache, max_gleanings=0
    )
    assert relationships[0].source == "KNOWN"
    assert relationships[0].target == "UNKNOWN ELSEWHERE"


# ---------------------------------------------------------------------------
# Claim extraction
# ---------------------------------------------------------------------------


def test_extract_claims_known_fixture() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    response = _claim_record("Ada Lovelace", "Charles Babbage", "COLLABORATION", "TRUE", "worked together") + COMPLETION_DELIM
    client = FakeExtractionClient(lambda s, u, i: response)

    claims, calls = extract_claims(
        "Ada Lovelace worked with Charles Babbage.",
        ["ADA LOVELACE", "CHARLES BABBAGE"],
        client=client,
        cache=cache,
    )
    assert len(claims) == 1
    claim = claims[0]
    assert claim.subject == "ADA LOVELACE"
    assert claim.object == "CHARLES BABBAGE"
    assert claim.type == "COLLABORATION"
    assert claim.status == "TRUE"
    assert claim.period_start is None
    assert claim.period_end is None
    assert calls == 1


def test_extract_claims_returns_empty_with_no_entities_and_makes_no_call() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    client = FakeExtractionClient("should never be called")

    claims, calls = extract_claims("some text", [], client=client, cache=cache)
    assert claims == []
    assert calls == 0
    assert client.calls == []


def test_extract_claims_normalizes_unknown_status_to_suspected() -> None:
    conn = _memory_conn()
    cache = LlmCache(conn)
    response = _claim_record("Subject", "NONE", "TYPE", "MAYBE", "unclear claim") + COMPLETION_DELIM
    client = FakeExtractionClient(lambda s, u, i: response)

    claims, _calls = extract_claims("text", ["SUBJECT"], client=client, cache=cache)
    assert claims[0].status == "SUSPECTED"
    assert claims[0].object is None


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def test_chunk_text_splits_on_headings() -> None:
    body = "## Section One\n\nContent one.\n\n## Section Two\n\nContent two.\n"
    chunks = chunk_text(body)
    assert len(chunks) == 2
    assert "Section One" in chunks[0].text
    assert "Section Two" in chunks[1].text


def test_chunk_text_is_deterministic_and_hashes_stably() -> None:
    body = "Some plain paragraph text with no headings at all."
    first = chunk_text(body)
    second = chunk_text(body)
    assert [c.content_hash for c in first] == [c.content_hash for c in second]


def test_chunk_text_empty_body_returns_no_units() -> None:
    assert chunk_text("   \n\n  ") == []


# ---------------------------------------------------------------------------
# GraphStore
# ---------------------------------------------------------------------------


def test_graph_store_upsert_entity_dedups_on_title_and_type() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    first_id = store.upsert_entity("ADA LOVELACE", "PERSON", "a mathematician")
    second_id = store.upsert_entity("ADA LOVELACE", "PERSON", "also a programmer")
    assert first_id == second_id
    row = conn.execute("SELECT description FROM entities WHERE id = ?", (first_id,)).fetchone()
    assert "a mathematician" in row["description"]
    assert "also a programmer" in row["description"]


def test_graph_store_delete_orphan_entities_keeps_entities_with_provenance() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    keeper_id = store.upsert_entity("KEPT", "CONCEPT", "d")
    store.upsert_entity("ORPHAN", "CONCEPT", "d")

    text_unit_id = store.upsert_text_unit("wiki/concepts/a.md", 0, "text", 2, "hash1")
    store.link_text_unit_entity(text_unit_id, keeper_id)
    # orphan_id has no text_unit_entities row and no relationships.

    deleted = store.delete_orphan_entities()
    assert deleted == 1
    remaining_titles = {row["title"] for row in conn.execute("SELECT title FROM entities")}
    assert remaining_titles == {"KEPT"}


def test_graph_store_upsert_relationship_dedups_on_source_target_type() -> None:
    conn = _memory_conn()
    store = GraphStore(conn)
    a_id = store.upsert_entity("A", "CONCEPT", "")
    b_id = store.upsert_entity("B", "CONCEPT", "")

    first_id = store.upsert_relationship(a_id, b_id, "RELATED", "first mention", 1.0)
    second_id = store.upsert_relationship(a_id, b_id, "RELATED", "", 3.0)

    assert first_id == second_id
    rows = conn.execute("SELECT weight, description FROM relationships").fetchall()
    assert len(rows) == 1
    assert rows[0]["weight"] == 3.0
    # empty incoming description must not clobber the existing one.
    assert rows[0]["description"] == "first mention"

    third_id = store.upsert_relationship(a_id, b_id, "RELATED", "stronger mention", 2.0)
    assert third_id == first_id
    row = conn.execute("SELECT weight, description FROM relationships").fetchone()
    # weight keeps the max seen so far, not the latest.
    assert row["weight"] == 3.0
    assert row["description"] == "stronger mention"

    store.recompute_degree(a_id)
    degree = conn.execute("SELECT degree FROM entities WHERE id = ?", (a_id,)).fetchone()["degree"]
    assert degree == 1


def test_ensure_graph_vec_tables_noop_when_vec_inactive() -> None:
    conn = _memory_conn()
    ensure_graph_vec_tables(conn, vec_active=False, dim=16)
    tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "entity_vectors" not in tables
    assert "text_unit_vectors" not in tables


# ---------------------------------------------------------------------------
# Full-pipeline: reindex_graph (chunk -> extract -> claims -> persist)
# ---------------------------------------------------------------------------


def _seed_two_page_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Ada Lovelace",
            body="Ada Lovelace worked with Charles Babbage on the Analytical Engine.",
        ),
    )
    write_page(
        vault, WikiPage.new(page_type="concept", title="Gardening", body="Water tomatoes daily in summer.")
    )
    return vault


def _fixture_for_two_page_vault(system: str, user: str, idx: int) -> str:
    if "MANY entities" in user:
        return COMPLETION_DELIM
    if "Known entities" in user:
        return _claim_record("Ada Lovelace", "Charles Babbage", "COLLABORATION", "TRUE", "worked together") + COMPLETION_DELIM
    if "Ada Lovelace" in user:
        return (
            _entity_record("Ada Lovelace", "PERSON", "a mathematician")
            + RECORD_DELIM
            + _entity_record("Charles Babbage", "PERSON", "an inventor")
            + RECORD_DELIM
            + _relationship_record("Ada Lovelace", "Charles Babbage", "collaborated", "9")
            + COMPLETION_DELIM
        )
    return COMPLETION_DELIM  # "Gardening" page: nothing to extract


def test_reindex_graph_full_pipeline_populates_entities_relationships_claims(tmp_path: Path) -> None:
    vault = _seed_two_page_vault(tmp_path)
    client = FakeExtractionClient(_fixture_for_two_page_vault)

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        report = reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )

        assert report.entities_upserted == 2
        assert report.relationships_upserted == 1
        assert report.claims_upserted == 1

        entities = {row["title"] for row in store.conn.execute("SELECT title FROM entities")}
        assert entities == {"ADA LOVELACE", "CHARLES BABBAGE"}


def test_reindex_graph_is_idempotent_zero_new_calls_on_unchanged_reindex(tmp_path: Path) -> None:
    vault = _seed_two_page_vault(tmp_path)
    client = FakeExtractionClient(_fixture_for_two_page_vault)

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        first_report = reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        entity_ids_before = {
            row["title"]: row["id"] for row in store.conn.execute("SELECT id, title FROM entities")
        }
        calls_before = len(client.calls)
        assert first_report.llm_calls > 0

        second_report = reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        entity_ids_after = {
            row["title"]: row["id"] for row in store.conn.execute("SELECT id, title FROM entities")
        }

        assert second_report.llm_calls == 0
        assert len(client.calls) == calls_before  # zero new client invocations
        assert entity_ids_after == entity_ids_before  # stable entity IDs


def test_reindex_graph_incremental_only_changed_page_reextracts(tmp_path: Path) -> None:
    vault = _seed_two_page_vault(tmp_path)
    client = FakeExtractionClient(_fixture_for_two_page_vault)

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        calls_after_first = len(client.calls)

    # Change only the Gardening page -- Ada Lovelace's text unit hash is untouched.
    gardening_path = vault / "wiki" / "concepts" / "gardening.md"
    text = gardening_path.read_text(encoding="utf-8")
    gardening_path.write_text(text.rstrip("\n") + "\n\nAlso rotate the crops.\n", encoding="utf-8")

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        report = reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        # The Gardening fixture returns COMPLETION_DELIM (no entities) for
        # every call, so re-extracting it costs exactly one LLM call and
        # zero new entities/relationships/claims.
        assert len(client.calls) == calls_after_first + 1
        assert report.entities_upserted == 0
        assert report.relationships_upserted == 0
        assert report.text_units_updated == 1

        # Ada Lovelace's entities/relationships are untouched.
        entities = {row["title"] for row in store.conn.execute("SELECT title FROM entities")}
        assert entities == {"ADA LOVELACE", "CHARLES BABBAGE"}


def test_reindex_graph_deleting_a_page_removes_its_orphan_entities(tmp_path: Path) -> None:
    vault = _seed_two_page_vault(tmp_path)
    client = FakeExtractionClient(_fixture_for_two_page_vault)

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )

    (vault / "wiki" / "concepts" / "ada-lovelace.md").unlink()

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        report = reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        assert report.entities_deleted == 2
        entities = list(store.conn.execute("SELECT * FROM entities"))
        assert entities == []
        relationships = list(store.conn.execute("SELECT * FROM relationships"))
        assert relationships == []


def test_reindex_graph_embeds_text_units_when_vec_active(tmp_path: Path) -> None:
    vault = _seed_two_page_vault(tmp_path)
    client = FakeExtractionClient(_fixture_for_two_page_vault)

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=None) as store:
        store.reindex(vault)
        reindex_graph(
            vault, store.conn, extraction_client=client, embedder=store.embedder,
            vec_active=store.vec_active, model="mock", max_gleanings=0,
        )
        if not store.vec_active:
            pytest.skip("sqlite-vec extension unavailable on this host")
        count = store.conn.execute("SELECT COUNT(*) AS n FROM text_unit_vectors").fetchone()["n"]
        assert count >= 1
