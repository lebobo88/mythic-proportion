"""Tests for the local web UI (Phase 7).

Guarded by ``pytest.importorskip("fastapi")`` so the rest of the suite still
passes conceptually on a host without the optional ``web`` extra installed;
these tests are only collected/run when ``fastapi`` (and its ``TestClient``)
are actually importable.
"""

from __future__ import annotations

from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")

from mythic_proportion.compile.models import WikiPage  # noqa: E402
from mythic_proportion.compile.writer import write_page  # noqa: E402
from mythic_proportion.graph.communities import compute_communities  # noqa: E402
from mythic_proportion.graph.extract import FakeExtractionClient  # noqa: E402
from mythic_proportion.graph.index import reindex_graph  # noqa: E402
from mythic_proportion.graph.tuples import COMPLETION_DELIM, TUPLE_DELIM  # noqa: E402
from mythic_proportion.index.embeddings import HashEmbedder  # noqa: E402
from mythic_proportion.index.store import IndexStore  # noqa: E402
from mythic_proportion.vault.init import init_vault  # noqa: E402
from mythic_proportion.web.app import create_app  # noqa: E402
from mythic_proportion.web.pages import collect_pages  # noqa: E402
from mythic_proportion.web.render import render_snippet_html  # noqa: E402

try:
    import graspologic  # noqa: F401

    _HAS_GRASPOLOGIC = True
except ImportError:
    _HAS_GRASPOLOGIC = False


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Hybrid Retrieval",
            body=(
                "Hybrid retrieval combines BM25 sparse search with vector cosine "
                "reranking for fast, accurate results over the wiki. See "
                "[[Wikilink Graph]] for more."
            ),
        ),
    )
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Wikilink Graph",
            body=(
                "The knowledge graph in this vault is made entirely of "
                "[[Hybrid Retrieval]]-indexed wikilinks between Markdown pages, "
                "not a separate database."
            ),
        ),
    )
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        store.reindex(vault)
    return vault


def _client(vault: Path) -> "fastapi.testclient.TestClient":
    from fastapi.testclient import TestClient

    app = create_app(vault)
    return TestClient(app)


def test_index_serves_html(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Mythic Proportion" in response.text


def test_static_assets_are_served(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/static/app.js")
    assert response.status_code == 200

    response = client.get("/static/styles.css")
    assert response.status_code == 200


def test_api_pages_lists_seeded_pages(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/pages")
    assert response.status_code == 200
    data = response.json()
    titles = {p["title"] for p in data["pages"]}
    assert {"Hybrid Retrieval", "Wikilink Graph"} <= titles
    for page in data["pages"]:
        assert page["type"] == "concept"
        assert "link_count" in page
        assert "backlink_count" in page


def test_api_page_renders_html_and_resolves_wikilinks(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/page", params={"path": "wiki/concepts/hybrid-retrieval.md"})
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Hybrid Retrieval"
    assert data["type"] == "concept"
    assert "raw_markdown" in data
    assert "<a" in data["html"]
    assert "/#/page?path=" in data["html"]
    assert any(link["title"] == "Wikilink Graph" for link in data["outbound"])
    assert any(link["title"] == "Wikilink Graph" for link in data["backlinks"])


def test_api_page_missing_returns_404(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/page", params={"path": "wiki/concepts/does-not-exist.md"})
    assert response.status_code == 404


def test_api_page_html_escapes_hostile_content(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Hostile Page",
            body="<script>alert('xss')</script> and some *emphasis* text.",
        ),
    )
    client = _client(vault)

    response = client.get("/api/page", params={"path": "wiki/concepts/hostile-page.md"})
    assert response.status_code == 200
    data = response.json()
    assert "<script>" not in data["html"]
    assert "&lt;script&gt;" in data["html"]


def test_api_search_finds_relevant_page(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/search", params={"q": "hybrid retrieval bm25", "k": 5})
    assert response.status_code == 200
    data = response.json()
    assert data["results"]
    assert data["results"][0]["page_path"] == "wiki/concepts/hybrid-retrieval.md"


def test_api_search_snippet_uses_mark_tags_not_literal_brackets(tmp_path: Path) -> None:
    """Regression for defect #1: FTS5 snippet markers must not be literal
    `[`/`]` -- those collided with `[[wikilinks]]` (stacking into a noisy
    `[[[Golden] [Ratio]]]`) and bracketed nearly every matched token
    (including stopwords). `snippet`/`snippet_html` must use `<mark>` markers
    instead, and `snippet_html` must be safe to inject directly as HTML
    (hostile content escaped, only the `<mark>` tag pair left un-escaped)."""
    vault = _seed_vault(tmp_path)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Golden Ratio Notes",
            body=(
                "The golden ratio, often written as <script>alert(1)</script>, is "
                "a mathematical constant seen in [[Hybrid Retrieval]] discussions."
            ),
        ),
    )
    client = _client(vault)

    response = client.get("/api/search", params={"q": "golden ratio", "k": 5})
    assert response.status_code == 200
    results = response.json()["results"]
    hit = next(r for r in results if r["page_path"] == "wiki/concepts/golden-ratio-notes.md")

    assert "[" not in hit["snippet"]
    assert "]" not in hit["snippet"]
    assert "<mark>" in hit["snippet"]
    assert "[[[" not in hit["snippet"]

    assert "<mark>" in hit["snippet_html"]
    assert "</mark>" in hit["snippet_html"]
    assert "<script>" not in hit["snippet_html"]
    assert "&lt;script&gt;" in hit["snippet_html"]


def test_api_query_never_500s_when_no_provider_configured(tmp_path: Path, monkeypatch) -> None:
    """No AUTHHUB_API_KEY/ANTHROPIC_API_KEY configured -- `/api/query` must
    still return 200 with an actionable error notice (never 500), and must
    still surface retrieval hits alongside the error so the user sees
    relevant pages even without synthesis."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    # use_llm defaults to True now.
    response = client.post("/api/query", json={"question": "how does hybrid retrieval work?"})
    assert response.status_code == 200
    data = response.json()
    assert data["used_llm"] is False
    assert data["error"] is True
    assert "AUTHHUB_API_KEY" in data["text"]
    assert data["hits"]  # retrieval still ran, so relevant pages are surfaced


def test_api_query_with_injected_fake_client_synthesizes(tmp_path: Path) -> None:
    """Exercise the success path via a fake client injected through
    ``settings``/dependency override -- ``create_app`` doesn't expose direct
    client injection, so this drives ``answer_query`` directly (the same
    function `/api/query` calls) to prove the synthesis contract, and
    separately checks the endpoint's never-500 wrapper above."""
    from mythic_proportion.config import Settings
    from mythic_proportion.query.client import AnswerResult, FakeAnswerClient
    from mythic_proportion.query.engine import answer_query

    vault = _seed_vault(tmp_path)
    client = FakeAnswerClient(
        AnswerResult(text="Hybrid retrieval blends BM25 and vectors [[Hybrid Retrieval]].", citations=[])
    )
    # Redaction is on by default and, with [privacy]/[privacy-full] installed
    # in this dev environment, building a real default Redactor() loads an
    # actual local transformer pipeline (multi-second). This test exercises
    # the synthesis contract, not privacy, so it explicitly opts out (see
    # test_privacy_redact.py for dedicated redaction-behavior coverage).
    answer = answer_query(
        vault, "how does hybrid retrieval work?", client=client, settings=Settings(vault_path=vault, redaction_enabled=False)
    )
    assert answer.used_llm is True
    assert "Hybrid Retrieval" in answer.citations


def test_api_query_omitted_mode_returns_exact_legacy_shape_unconditionally(
    tmp_path: Path, monkeypatch
) -> None:
    """CORRECTED per memory/invariants.md's "POST /api/query contract --
    CORRECTION" entry: omitting `mode` entirely (every pre-Phase-4 caller)
    must ALWAYS take the exact legacy path and return the exact legacy
    5-key shape -- no `mode`/`mode_detail` keys, and no `source_kind` on
    any hit -- unconditionally, never contingent on graph/communities
    state."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/query", json={"question": "how does hybrid retrieval work?"})
    assert response.status_code == 200
    data = response.json()
    assert data["used_llm"] is False
    assert data["error"] is True
    assert set(data.keys()) == {"text", "citations", "hits", "used_llm", "error"}
    assert "mode" not in data
    assert "mode_detail" not in data
    for hit in data["hits"]:
        assert "source_kind" not in hit


def test_api_query_explicit_mode_surfaces_mode_and_source_kind(tmp_path: Path, monkeypatch) -> None:
    """The counterpart to the omitted-mode test above: an explicit `mode`
    key must surface `mode`/`mode_detail` in the response, and
    `source_kind` on every hit."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/query", json={"question": "how does hybrid retrieval work?", "mode": "legacy"})
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "legacy"
    assert "mode_detail" in data
    for hit in data["hits"]:
        assert hit["source_kind"] == "page"


def test_api_query_unknown_mode_never_500s(tmp_path: Path) -> None:
    """An invalid `mode` string must degrade gracefully (per the existing
    never-500 contract), not crash the request."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/query", json={"question": "anything", "mode": "not-a-real-mode"})
    assert response.status_code == 200
    data = response.json()
    assert data["error"] is True
    # An explicit (even invalid) `mode` key still counts as "explicit" for
    # response-shape purposes.
    assert data["mode"] == "not-a-real-mode"


def test_api_graph_returns_nodes_and_edges(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/graph")
    assert response.status_code == 200
    data = response.json()
    node_ids = {n["id"] for n in data["nodes"]}
    assert "wiki/concepts/hybrid-retrieval.md" in node_ids
    assert "wiki/concepts/wikilink-graph.md" in node_ids
    assert data["edges"]
    for node in data["nodes"]:
        assert node["type"] == "concept"


def _seed_entity_fixture_response(system: str, user: str, idx: int) -> str:
    if "MANY entities" in user:
        return COMPLETION_DELIM
    if "Hybrid" in user or "hybrid" in user:
        return (
            '("entity"' + TUPLE_DELIM + "Hybrid Search" + TUPLE_DELIM + "CONCEPT" + TUPLE_DELIM
            + "a retrieval technique)" + COMPLETION_DELIM
        )
    return COMPLETION_DELIM


def test_api_graph_default_mode_is_unchanged_wikilink_shape(tmp_path: Path) -> None:
    """Extending `/api/graph` with `mode` must not change the default response
    at all (N9 preserved invariant) -- same query param omitted, same shape."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/graph")
    assert response.status_code == 200
    data = response.json()
    for node in data["nodes"]:
        assert set(node.keys()) == {"id", "label", "type"}
    for edge in data["edges"]:
        assert set(edge.keys()) == {"source", "target"}


def test_api_graph_mode_wikilinks_explicit_matches_default(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    default_response = client.get("/api/graph").json()
    explicit_response = client.get("/api/graph", params={"mode": "wikilinks"}).json()
    assert default_response == explicit_response


def test_api_graph_mode_entities_returns_extracted_entity_graph(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)

    llm_client = FakeExtractionClient(_seed_entity_fixture_response)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        # `reindex_graph` now defaults to `collect_raw_sources` (real `raw/`
        # ingested documents), not `collect_pages` (`wiki/`) -- these tests
        # only ever seeded `wiki/` pages directly (no real ingest run), so
        # the wiki-derived page list is passed explicitly to preserve their
        # original intent (extracting entities from the seeded wiki content).
        reindex_graph(
            vault,
            store.conn,
            extraction_client=llm_client,
            embedder=store.embedder,
            vec_active=store.vec_active,
            model="mock",
            max_gleanings=0,
            pages=collect_pages(vault),
        )

    web_client = _client(vault)
    response = web_client.get("/api/graph", params={"mode": "entities"})
    assert response.status_code == 200
    data = response.json()
    assert any(node["label"] == "HYBRID SEARCH" and node["kind"] == "entity" for node in data["nodes"])


@pytest.mark.skipif(not _HAS_GRASPOLOGIC, reason="graspologic (or a leidenalg fallback) is not installed")
def test_api_graph_mode_entities_includes_community_level_and_centrality_when_computed(
    tmp_path: Path,
) -> None:
    """Phase 4b (plan Section 6.4/7): once `compute_communities` has run,
    `GET /api/graph?mode=entities` projects `community`/`level`/`centrality`
    onto each entity node -- additive fields layered on top of the existing
    id/label/type/kind/degree shape, never replacing it (N9-style backward
    compatibility, mirroring the already-preserved `/api/query` invariant)."""
    vault = _seed_vault(tmp_path)

    llm_client = FakeExtractionClient(_seed_entity_fixture_response)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        reindex_graph(
            vault,
            store.conn,
            extraction_client=llm_client,
            embedder=store.embedder,
            vec_active=store.vec_active,
            model="mock",
            max_gleanings=0,
            pages=collect_pages(vault),
        )
        compute_communities(store.conn, random_seed=42)

    web_client = _client(vault)
    response = web_client.get("/api/graph", params={"mode": "entities"})
    assert response.status_code == 200
    data = response.json()
    entity_node = next(n for n in data["nodes"] if n["label"] == "HYBRID SEARCH")

    # Every pre-Phase-4b field is untouched -- additive only.
    assert {"id", "label", "type", "kind", "degree"} <= set(entity_node.keys())
    assert isinstance(entity_node["community"], int)
    assert isinstance(entity_node["level"], int)
    assert set(entity_node["centrality"].keys()) == {"degree", "eigenvector"}
    assert 0.0 <= entity_node["centrality"]["degree"] <= 1.0
    assert 0.0 <= entity_node["centrality"]["eigenvector"] <= 1.0


def test_api_graph_mode_entities_is_empty_before_any_extraction_run(tmp_path: Path) -> None:
    """No `mythic index-graph` run yet -- must be an empty (not erroring) entity graph."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/graph", params={"mode": "entities"})
    assert response.status_code == 200
    assert response.json() == {"nodes": [], "edges": []}


def test_api_graph_mode_both_unions_pages_and_entities(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)

    llm_client = FakeExtractionClient(_seed_entity_fixture_response)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        # `reindex_graph` now defaults to `collect_raw_sources` (real `raw/`
        # ingested documents), not `collect_pages` (`wiki/`) -- these tests
        # only ever seeded `wiki/` pages directly (no real ingest run), so
        # the wiki-derived page list is passed explicitly to preserve their
        # original intent (extracting entities from the seeded wiki content).
        reindex_graph(
            vault,
            store.conn,
            extraction_client=llm_client,
            embedder=store.embedder,
            vec_active=store.vec_active,
            model="mock",
            max_gleanings=0,
            pages=collect_pages(vault),
        )

    web_client = _client(vault)
    response = web_client.get("/api/graph", params={"mode": "both"})
    assert response.status_code == 200
    data = response.json()
    kinds = {node["kind"] for node in data["nodes"]}
    assert kinds == {"page", "entity"}


def _seed_graph_entities(
    vault: Path,
    entities: list[tuple[str, str]],
    relationships: list[tuple[str, str, str, float]] | None = None,
    provenance: list[tuple[str, str]] | None = None,
) -> dict[str, int]:
    """Write entities/relationships straight into the GraphRAG tables (no LLM
    extraction round trip needed) -- ``read_entity_graph`` reads these tables
    directly, so this is the narrowest deterministic seam for the ``mode=both``
    identity-dedup tests below. Titles are passed pre-normalized (uppercase),
    matching ``upsert_entity``'s documented caller contract.

    ``provenance`` is a list of ``(entity title, raw source page_path)``
    pairs (``text_units.page_path``, e.g. ``raw/<hash>.md``) recording which
    source document the entity was "extracted from", wired exactly the way
    ``graph.index.reindex_graph`` records it: a ``text_units`` row plus a
    ``text_unit_entities`` link (applied to EVERY seeded entity sharing that
    title, so ambiguous-title fixtures can provenance-link all twins). The
    ``mode=both`` dedup requires this provenance to connect back to the
    page's own ``source_hash`` before merging (Codex J-001)."""
    from mythic_proportion.graph.store import GraphStore

    with IndexStore(vault, embedder=None, sync_embedder=False) as store:
        graph_store = GraphStore(store.conn)
        ids: dict[str, int] = {}
        all_ids: list[tuple[str, int]] = []
        for title, type_ in entities:
            entity_id = graph_store.upsert_entity(title, type_, "seeded for mode=both dedup tests")
            ids[title] = entity_id
            all_ids.append((title, entity_id))
        chunk_index = 0
        for title, raw_page_path in provenance or []:
            for seeded_title, entity_id in all_ids:
                if seeded_title != title:
                    continue
                text_unit_id = graph_store.upsert_text_unit(
                    raw_page_path, chunk_index, f"seeded provenance {chunk_index}", 5, f"hash-{chunk_index}"
                )
                chunk_index += 1
                graph_store.link_text_unit_entity(text_unit_id, entity_id)
        for source, target, rel_type, weight in relationships or []:
            graph_store.upsert_relationship(ids[source], ids[target], rel_type, "seeded", weight)
        for entity_id in ids.values():
            graph_store.recompute_degree(entity_id)
    return ids


def _rewrite_page_with_source_hash(vault: Path, page_type: str, title: str, body: str, source_hash: str) -> None:
    """Re-write one seeded wiki page in place with a ``source_hash`` in its
    frontmatter -- the shape the real compile pipeline produces for a page
    generated from an ingested raw document (see ``WikiPage``'s docstring)."""
    write_page(
        vault,
        WikiPage.new(page_type=page_type, title=title, body=body, source_hash=source_hash),
    )


def test_api_graph_mode_both_merges_wiki_page_backed_entity_into_one_node(tmp_path: Path) -> None:
    """Root cause of the "Meridian Logistics" framing defect (T3 advisory H1,
    independently confirmed against the demo vault): ``mode=both`` unioned page
    nodes and entity nodes with NO identity dedup, so a wiki-page-backed entity
    appeared as TWO same-labeled nodes -- and when the page twin was isolated
    (zero wikilink edges), clicking it framed a degenerate one-point set with no
    edge in sight. A page and an entity whose normalized titles match 1:1 must
    now merge into ONE node that keeps the page id (load-bearing for the
    reading pane, Open-in-Wiki, and Cmd+K jump) and absorbs the entity twin's
    edges. Codex J-001: the title match is necessary but NOT sufficient --
    the merge additionally requires real extraction provenance (the page's
    ``source_hash`` names a raw document the entity was extracted from)."""
    vault = _seed_vault(tmp_path)
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines sparse and dense search. See [[Wikilink Graph]] for more.",
        "cafe0001",
    )
    ids = _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "CONCEPT"), ("ORPHAN CONCEPT", "CONCEPT")],
        relationships=[("HYBRID RETRIEVAL", "ORPHAN CONCEPT", "RELATED_TO", 2.0)],
        provenance=[("HYBRID RETRIEVAL", "raw/cafe0001.md")],
    )

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    hybrid_nodes = [n for n in data["nodes"] if n["label"].lower() == "hybrid retrieval"]
    assert len(hybrid_nodes) == 1, f"expected one merged node, got {hybrid_nodes}"
    merged = hybrid_nodes[0]
    assert merged["id"] == "wiki/concepts/hybrid-retrieval.md"
    assert merged["kind"] == "page"
    assert merged["entityId"] == f"entity:{ids['HYBRID RETRIEVAL']}"
    # The entity twin's own id must be gone from the node list entirely.
    node_ids = {n["id"] for n in data["nodes"]}
    assert f"entity:{ids['HYBRID RETRIEVAL']}" not in node_ids
    # The entity-only `degree` field must NOT ride onto the merged node: it
    # counts only relationship edges, so it would understate the merged node's
    # true degree -- omitting it lets the client recompute from the union
    # edge list (`deriveVizGraph` prefers a server `degree` when present).
    assert "degree" not in merged

    # The entity twin's relationship edge survives, remapped onto the page id,
    # with its typed/weighted shape intact.
    remapped = [
        e
        for e in data["edges"]
        if e["source"] == "wiki/concepts/hybrid-retrieval.md"
        and e["target"] == f"entity:{ids['ORPHAN CONCEPT']}"
    ]
    assert len(remapped) == 1
    assert remapped[0]["type"] == "RELATED_TO"
    assert remapped[0]["weight"] == 2.0

    # An entity with no matching page stays a distinct entity node.
    assert any(
        n["id"] == f"entity:{ids['ORPHAN CONCEPT']}" and n["kind"] == "entity" for n in data["nodes"]
    )


def test_api_graph_mode_both_merge_leaves_no_dangling_or_duplicate_edges(tmp_path: Path) -> None:
    """When BOTH endpoints of a relationship merge into their page twins, the
    remapped edge must land between the two page ids, collide-away the
    redundant untyped wikilink duplicate of the same (source, target) pair,
    and leave no edge pointing at a removed ``entity:`` node id."""
    vault = _seed_vault(tmp_path)
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines sparse and dense search. See [[Wikilink Graph]] for more.",
        "cafe0001",
    )
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Wikilink Graph",
        "The knowledge graph is made of [[Hybrid Retrieval]]-indexed wikilinks.",
        "cafe0002",
    )
    _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "CONCEPT"), ("WIKILINK GRAPH", "CONCEPT")],
        relationships=[("HYBRID RETRIEVAL", "WIKILINK GRAPH", "DESCRIBES", 3.0)],
        provenance=[
            ("HYBRID RETRIEVAL", "raw/cafe0001.md"),
            ("WIKILINK GRAPH", "raw/cafe0002.md"),
        ],
    )

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    # Both entities merged -- no entity: node ids remain at all.
    assert not any(n["id"].startswith("entity:") for n in data["nodes"])

    pairs = [(e["source"], e["target"]) for e in data["edges"]]
    assert len(pairs) == len(set(pairs)), f"duplicate edge pairs: {pairs}"

    # The surviving hybrid->wikilink edge is the richer typed/weighted one.
    edge = next(
        e
        for e in data["edges"]
        if e["source"] == "wiki/concepts/hybrid-retrieval.md"
        and e["target"] == "wiki/concepts/wikilink-graph.md"
    )
    assert edge["type"] == "DESCRIBES"
    assert edge["weight"] == 3.0

    # Every edge endpoint resolves to a node that actually exists.
    node_ids = {n["id"] for n in data["nodes"]}
    for source, target in pairs:
        assert source in node_ids
        assert target in node_ids


def test_api_graph_mode_both_never_merges_an_ambiguous_title_match(tmp_path: Path) -> None:
    """Two entities sharing one normalized title (different types) cannot be
    safely merged into the single matching page -- identity is ambiguous, so
    all three same-labeled nodes stay exactly as before the dedup. Both
    entities carry VALID provenance back to the page's own source document
    here, so this test isolates the ambiguity rule specifically -- provenance
    alone cannot rescue an ambiguous title match."""
    vault = _seed_vault(tmp_path)
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines sparse and dense search. See [[Wikilink Graph]] for more.",
        "cafe0003",
    )
    _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "CONCEPT"), ("HYBRID RETRIEVAL", "ORGANIZATION")],
        provenance=[("HYBRID RETRIEVAL", "raw/cafe0003.md")],
    )

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    same_label = [n for n in data["nodes"] if n["label"].lower() == "hybrid retrieval"]
    assert len(same_label) == 3
    page_node = next(n for n in same_label if n["kind"] == "page")
    assert "entityId" not in page_node


def test_api_graph_mode_both_title_coincidence_alone_never_merges(tmp_path: Path) -> None:
    """Codex CODE_REVIEW J-001 (major): a title-string match is NOT identity.
    A hand-authored wiki page (no ``source_hash`` -- it was never compiled
    from an ingested document) that merely shares a normalized title with an
    independently-extracted entity must NOT be fused with it: fusing would
    silently misattribute the entity's relationships/enrichment to an
    unrelated page with no visible error. Both twins must survive."""
    vault = _seed_vault(tmp_path)  # seeded pages carry no source_hash at all
    ids = _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "ORGANIZATION")],
        provenance=[("HYBRID RETRIEVAL", "raw/1111beef.md")],
    )

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    same_label = [n for n in data["nodes"] if n["label"].lower() == "hybrid retrieval"]
    assert len(same_label) == 2, f"expected both twins to survive, got {same_label}"
    page_node = next(n for n in same_label if n["kind"] == "page")
    assert "entityId" not in page_node
    assert any(n["id"] == f"entity:{ids['HYBRID RETRIEVAL']}" for n in data["nodes"])


def test_api_graph_mode_both_provenance_mismatch_never_merges(tmp_path: Path) -> None:
    """Codex CODE_REVIEW J-001 (major), second face: even when the page WAS
    compiled from an ingested document, a same-titled entity extracted from a
    DIFFERENT document is not the same thing -- the source_hash/provenance
    link must actually connect before a merge is allowed."""
    vault = _seed_vault(tmp_path)
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines sparse and dense search. See [[Wikilink Graph]] for more.",
        "cafe0001",
    )
    ids = _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "CONCEPT")],
        provenance=[("HYBRID RETRIEVAL", "raw/2222feed.md")],  # a different document
    )

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    same_label = [n for n in data["nodes"] if n["label"].lower() == "hybrid retrieval"]
    assert len(same_label) == 2
    page_node = next(n for n in same_label if n["kind"] == "page")
    assert "entityId" not in page_node
    assert any(n["id"] == f"entity:{ids['HYBRID RETRIEVAL']}" for n in data["nodes"])


def test_api_graph_mode_both_merged_node_inherits_the_entity_enrichment_projection(
    tmp_path: Path,
) -> None:
    """The Phase 4b per-node Leiden projection (community/level/centrality)
    must ride onto the merged page node -- the merge must not strand the real
    enrichment on a removed entity twin (which would silently demote the node
    to the client's "approximate" union-find fallback)."""
    vault = _seed_vault(tmp_path)
    _rewrite_page_with_source_hash(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines sparse and dense search. See [[Wikilink Graph]] for more.",
        "cafe0004",
    )
    ids = _seed_graph_entities(
        vault,
        entities=[("HYBRID RETRIEVAL", "CONCEPT")],
        provenance=[("HYBRID RETRIEVAL", "raw/cafe0004.md")],
    )
    with IndexStore(vault, embedder=None, sync_embedder=False) as store:
        store.conn.execute(
            "INSERT INTO communities(level, cluster, parent_cluster, entity_id) VALUES (0, 4, NULL, ?)",
            (ids["HYBRID RETRIEVAL"],),
        )
        store.conn.commit()

    client = _client(vault)
    data = client.get("/api/graph", params={"mode": "both"}).json()

    merged = next(n for n in data["nodes"] if n["id"] == "wiki/concepts/hybrid-retrieval.md")
    assert merged["community"] == 4
    assert merged["level"] == 0
    assert set(merged["centrality"].keys()) == {"degree", "eigenvector"}


def test_api_graph_rejects_invalid_mode(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/graph", params={"mode": "bogus"})
    assert response.status_code == 422


def test_api_graph_entities_mode_does_not_wipe_the_hybrid_search_index(tmp_path: Path) -> None:
    """Regression for the reject-triggering defect: `GET /api/graph?mode=entities`
    (and `mode=both`) must never touch `pages`/`pages_fts`/`page_vectors` or the
    stored `embedder_id`, no matter how it opens `IndexStore` to read the
    GraphRAG entity tables.

    Before the fix, that read opened `IndexStore(vault_root, embedder=None)`,
    which `_sync_embedder_meta` treated as an embedder-identity *change* against
    a vault already indexed with a real embedder (`HashEmbedder:64`, the
    `get_embedder` default for `Settings.embeddings_backend == "local"`) and
    wiped `pages`/`pages_fts`/`page_vectors` (+ dropped `vec_pages`) as a side
    effect of a single GET.
    """
    vault = _seed_vault(tmp_path)
    # Re-seed with the *app's own default* embedder identity (HashEmbedder
    # dim=64, matching `get_embedder(Settings())`) so the stored `embedder_id`
    # is exactly what `create_app`'s default settings would produce -- the
    # precise condition the reject repro needed to trigger the wipe.
    with IndexStore(vault, HashEmbedder(dim=64), use_vec=False) as store:
        store.reindex(vault)
        conn = store.conn
        pages_before = conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
        pages_fts_before = conn.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0]
        page_vectors_before = conn.execute("SELECT COUNT(*) FROM page_vectors").fetchone()[0]
        embedder_id_before = conn.execute(
            "SELECT value FROM meta WHERE key = 'embedder_id'"
        ).fetchone()[0]
    assert pages_before > 0
    assert pages_fts_before > 0
    assert page_vectors_before > 0
    assert embedder_id_before == "HashEmbedder:64"

    client = _client(vault)
    for mode in ("entities", "both"):
        response = client.get("/api/graph", params={"mode": mode})
        assert response.status_code == 200

    with IndexStore(vault, HashEmbedder(dim=64), use_vec=False, sync_embedder=False) as store:
        conn = store.conn
        assert conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0] == pages_before
        assert conn.execute("SELECT COUNT(*) FROM pages_fts").fetchone()[0] == pages_fts_before
        assert conn.execute("SELECT COUNT(*) FROM page_vectors").fetchone()[0] == page_vectors_before
        assert (
            conn.execute("SELECT value FROM meta WHERE key = 'embedder_id'").fetchone()[0]
            == embedder_id_before
        )


def test_api_lint_reports_clean_vault(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/lint")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["orphans"] == []


def test_api_lint_fix_creates_stub_for_dangling_link(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    write_page(
        vault,
        WikiPage.new(
            page_type="concept",
            title="Has A Broken Link",
            body="This page references [[Nonexistent]], which does not exist yet.",
        ),
    )
    client = _client(vault)

    before = client.get("/api/lint").json()
    assert before["ok"] is False
    assert any(d["target_title"] == "Nonexistent" for d in before["dangling_links"])

    fix_response = client.post("/api/lint/fix")
    assert fix_response.status_code == 200
    fix_data = fix_response.json()
    assert "Nonexistent" in fix_data["stubs_created"]
    assert fix_data["report"]["ok"] is True

    stub_path = vault / "wiki" / "concepts" / "nonexistent.md"
    assert stub_path.is_file()


def _wait_for_job(client: "fastapi.testclient.TestClient", job_id: str, *, timeout: float = 5.0) -> dict:
    """Poll ``GET /api/ingest/status`` until the job reports ``done``.

    A deterministic alternative to sleeping: used by tests instead of a
    fixed sleep, bounded by ``timeout`` so a genuinely stuck worker still
    fails the test rather than hanging it.
    """
    import time

    deadline = time.monotonic() + timeout
    data: dict = {}
    while time.monotonic() < deadline:
        response = client.get("/api/ingest/status", params={"job_id": job_id})
        assert response.status_code == 200
        data = response.json()
        if data["done"]:
            return data
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not finish within {timeout}s: {data}")


def _wait_for_graph_job(client: "fastapi.testclient.TestClient", job_id: str, *, timeout: float = 5.0) -> dict:
    """Same contract as :func:`_wait_for_job`, for `/api/index-graph/status`."""
    import time

    deadline = time.monotonic() + timeout
    data: dict = {}
    while time.monotonic() < deadline:
        response = client.get("/api/index-graph/status", params={"job_id": job_id})
        assert response.status_code == 200
        data = response.json()
        if data["done"]:
            return data
        time.sleep(0.02)
    raise AssertionError(f"graph job {job_id} did not finish within {timeout}s: {data}")


# ---------------------------------------------------------------------------
# POST /api/index-graph -- "Build Knowledge Graph" (Phase 3/4 bugfix DEFECT 1)
# ---------------------------------------------------------------------------


def test_api_index_graph_status_with_no_job_ever_enqueued_returns_idle_state(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/index-graph/status")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] is None
    assert data["done"] is True
    assert data["status"] == "idle"


def test_api_index_graph_missing_credential_reports_error_and_does_not_500(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/index-graph")
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    data = _wait_for_graph_job(client, job_id)
    assert data["status"] == "done"
    assert data["error"] is not None
    assert "AUTHHUB_API_KEY" in data["error"]


def test_api_index_graph_end_to_end_populates_entities(tmp_path: Path, monkeypatch) -> None:
    """`/api/index-graph` reads real `raw/` ingested content (bugfix
    DEFECT 2), via the same `build_extraction_client` the CLI uses (bugfix
    DEFECT 1) -- proven end-to-end through the actual HTTP job/status API,
    not by calling `reindex_graph` directly."""
    from mythic_proportion import graph as graph_package  # noqa: F401
    import mythic_proportion.graph.index as graph_index_module
    from mythic_proportion.graph.tuples import COMPLETION_DELIM, TUPLE_DELIM

    vault = _seed_vault(tmp_path)
    drop_dir = vault / "drop"
    drop_dir.mkdir(parents=True, exist_ok=True)
    (drop_dir / "note.md").write_text(
        "Grace Hopper worked on the COBOL programming language.", encoding="utf-8"
    )
    from mythic_proportion.ingest.pipeline import ingest_drop

    ingest_report = ingest_drop(vault)
    assert not ingest_report.errors

    fixture_response = (
        f'("entity"{TUPLE_DELIM}Grace Hopper{TUPLE_DELIM}PERSON{TUPLE_DELIM}a computer scientist)'
        f"{COMPLETION_DELIM}"
    )

    def _fake_build_extraction_client(settings):  # noqa: ANN001
        return FakeExtractionClient(lambda s, u, i: COMPLETION_DELIM if "MANY entities" in u else fixture_response)

    monkeypatch.setattr(graph_index_module, "build_extraction_client", _fake_build_extraction_client)

    client = _client(vault)
    response = client.post("/api/index-graph")
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    data = _wait_for_graph_job(client, job_id)
    assert data["status"] == "done"
    assert data["error"] is None
    assert data["entities_upserted"] == 1

    graph_response = client.get("/api/graph", params={"mode": "entities"})
    assert any(node["label"] == "GRACE HOPPER" for node in graph_response.json()["nodes"])


def test_api_upload_with_no_provider_configured_reports_error_and_does_not_500(
    tmp_path: Path, monkeypatch
) -> None:
    """No AUTHHUB_API_KEY/ANTHROPIC_API_KEY configured -- upload returns a
    job id immediately; once the background worker drains, the source has
    still ingested, but the required compile step fails cleanly: `compiled`
    stays 0 and the failure lands in `errors` (per-source), not a 500."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    content = b"# A Dropped Note\n\nSome plain markdown content about gardening.\n"
    response = client.post(
        "/api/upload",
        files={"files": ("note.md", content, "text/markdown")},
    )
    assert response.status_code == 200
    upload_data = response.json()
    assert "note.md" in upload_data["saved"]
    assert "job_id" in upload_data

    data = _wait_for_job(client, upload_data["job_id"])
    assert data["ingested"] == 1
    assert data["compiled"] == 0
    assert len(data["errors"]) == 1
    assert "AUTHHUB_API_KEY" in data["errors"][0]["message"]
    error_file = next(f for f in data["files"] if f["name"] == "note.md")
    assert error_file["status"] == "error"

    # No page was created for the uploaded source -- no more silent stub.
    pages_response = client.get("/api/pages")
    titles = {p["title"] for p in pages_response.json()["pages"]}
    assert not any("note" in t.lower() or "dropped" in t.lower() for t in titles)


def test_api_upload_with_fake_compile_client_succeeds(tmp_path: Path, monkeypatch) -> None:
    """The success path: `mythic_proportion.web.jobs.compile_source` (the
    background worker's copy of the reference, per `web.jobs`'s ownership of
    ingest execution) is monkeypatched to a stand-in that behaves like an
    injected `FakeCompileClient` would, proving `/api/upload` -> the worker
    counts a successful compile and creates a page for it."""
    from mythic_proportion.compile.models import CompileResult, WikiPage
    from mythic_proportion.web import jobs as web_jobs_module

    vault = _seed_vault(tmp_path)

    def _fake_compile_source(vault_root, source, *, settings=None, client=None, now=None):  # noqa: ANN001
        page = WikiPage.new(page_type="source", title=f"Compiled {source.original_name}", body="stand-in body")
        from mythic_proportion.compile.writer import write_page

        write_page(vault_root, page)
        return CompileResult(pages=[page], contradictions=[], links_created=[])

    monkeypatch.setattr(web_jobs_module, "compile_source", _fake_compile_source)

    fastapi_client = _client(vault)
    content = b"# A Dropped Note\n\nSome plain markdown content about gardening.\n"
    response = fastapi_client.post(
        "/api/upload",
        files={"files": ("note.md", content, "text/markdown")},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    data = _wait_for_job(fastapi_client, job_id)
    assert data["ingested"] == 1
    assert data["compiled"] == 1
    assert data["errors"] == []

    pages_response = fastapi_client.get("/api/pages")
    titles = {p["title"] for p in pages_response.json()["pages"]}
    assert any("note.md" in t for t in titles)


def test_render_snippet_html_allows_only_mark_tags() -> None:
    rendered = render_snippet_html("a <mark>golden</mark> <script>alert(1)</script> ratio")
    assert rendered == "a <mark>golden</mark> &lt;script&gt;alert(1)&lt;/script&gt; ratio"


def test_api_ingest_with_empty_drop_is_a_noop(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/ingest")
    assert response.status_code == 200
    job_id = response.json()["job_id"]

    data = _wait_for_job(client, job_id)
    assert data["ingested"] == 0
    assert data["compiled"] == 0
    assert data["status"] == "done"


def test_api_ingest_status_with_no_job_ever_enqueued_returns_idle_state(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/ingest/status")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] is None
    assert data["done"] is True
    assert data["status"] == "idle"
    assert data["files"] == []


def test_api_ingest_status_unknown_job_id_returns_idle_state(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/ingest/status", params={"job_id": "job-does-not-exist"})
    assert response.status_code == 200
    assert response.json()["status"] == "idle"


def test_api_jobs_endpoint_returns_404_for_unknown_job(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/jobs/job-does-not-exist")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Browser-audit item 2 -- /app SPA-fallback deep-link fix
# ---------------------------------------------------------------------------


def _static_next_index_html() -> bytes:
    from mythic_proportion.web.app import STATIC_NEXT_DIR

    return (STATIC_NEXT_DIR / "index.html").read_bytes()


def test_app_deep_link_serves_the_spa_shell_not_a_raw_404(tmp_path: Path) -> None:
    """A direct URL / hard refresh on a client-side SPA sub-route
    (`/app/graph`, `/app/search`, ...) must serve `index.html` -- the
    standard SPA-fallback pattern -- instead of the raw backend
    `{"detail": "Not Found"}`."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    index_html = _static_next_index_html()
    for path in ("/app/graph", "/app/search", "/app/some/deeply/nested/route"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.content == index_html
        assert "text/html" in response.headers["content-type"]


def test_app_root_still_serves_the_spa_shell(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/app")
    assert response.status_code == 200
    assert response.content == _static_next_index_html()


def test_app_real_build_asset_is_served_as_is(tmp_path: Path) -> None:
    """A real hashed build asset under `static_next/assets/` must still be
    served as that exact file, not SPA-fallback to `index.html`."""
    from mythic_proportion.web.app import STATIC_NEXT_DIR

    asset_files = list((STATIC_NEXT_DIR / "assets").iterdir())
    assert asset_files, "static_next/assets/ must be non-empty for this test to be meaningful"
    asset_name = asset_files[0].name

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get(f"/app/assets/{asset_name}")
    assert response.status_code == 200
    assert response.content == asset_files[0].read_bytes()


def test_app_missing_asset_path_stays_a_genuine_404_not_spa_fallback(tmp_path: Path) -> None:
    """A missing `assets/*` path is a real error (a stale/broken asset
    reference), never silently masked as a working SPA route."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/app/assets/does-not-exist-12345.js")
    assert response.status_code == 404


def test_app_missing_root_level_static_file_stays_a_genuine_404_not_spa_fallback(tmp_path: Path) -> None:
    """Codex J-003 (remediation cycle): a missing static-file-shaped
    reference OUTSIDE `assets/` -- e.g. `favicon.ico`, a manifest, a
    root-level stylesheet -- must also stay a real 404, not get silently
    served `index.html` as if it were a working SPA route."""
    from mythic_proportion.web.app import STATIC_NEXT_DIR

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    for missing_path in ("/app/favicon.ico", "/app/manifest.webmanifest", "/app/some-missing-file.css"):
        assert not (STATIC_NEXT_DIR / missing_path.removeprefix("/app/")).exists(), missing_path
        response = client.get(missing_path)
        assert response.status_code == 404, missing_path


def test_app_bare_client_route_with_a_dot_in_a_dotfile_style_segment_still_falls_back(tmp_path: Path) -> None:
    """A dotfile-STYLED bare route segment (leading dot, no real extension,
    e.g. `/app/.well-known/something`) is not mistaken for a static-file
    reference -- it still falls back to the SPA shell like any other bare
    client-side route."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/app/.well-known/something")
    assert response.status_code == 200
    assert response.content == _static_next_index_html()


def test_app_path_traversal_is_rejected(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/app/..%2F..%2F..%2Fetc%2Fpasswd", follow_redirects=True)
    assert response.status_code in (404, 400)
    assert "root:" not in response.text


def test_app_absent_static_next_still_404s(tmp_path: Path, monkeypatch) -> None:
    """When `static_next/` hasn't been built at all, `/app` (and any
    sub-route) must still 404, exactly as before this fix -- the
    `is_dir()` guard must still fully no-op the route registration."""
    from mythic_proportion.web import app as web_app_module

    monkeypatch.setattr(web_app_module, "STATIC_NEXT_DIR", tmp_path / "no-such-static-next-dir")
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/app/graph")
    assert response.status_code == 404


def test_api_404_is_unaffected_by_the_spa_fallback(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/this-route-does-not-exist")
    assert response.status_code == 404
