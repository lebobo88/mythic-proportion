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
from mythic_proportion.graph.extract import FakeExtractionClient  # noqa: E402
from mythic_proportion.graph.index import reindex_graph  # noqa: E402
from mythic_proportion.graph.tuples import COMPLETION_DELIM, TUPLE_DELIM  # noqa: E402
from mythic_proportion.index.embeddings import HashEmbedder  # noqa: E402
from mythic_proportion.index.store import IndexStore  # noqa: E402
from mythic_proportion.vault.init import init_vault  # noqa: E402
from mythic_proportion.web.app import create_app  # noqa: E402
from mythic_proportion.web.render import render_snippet_html  # noqa: E402


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
    from mythic_proportion.query.client import AnswerResult, FakeAnswerClient
    from mythic_proportion.query.engine import answer_query

    vault = _seed_vault(tmp_path)
    client = FakeAnswerClient(
        AnswerResult(text="Hybrid retrieval blends BM25 and vectors [[Hybrid Retrieval]].", citations=[])
    )
    answer = answer_query(vault, "how does hybrid retrieval work?", client=client)
    assert answer.used_llm is True
    assert "Hybrid Retrieval" in answer.citations


def test_api_query_default_mode_is_auto_and_preserves_legacy_behavior(tmp_path: Path, monkeypatch) -> None:
    """Phase 4: omitting `mode` entirely (every pre-Phase-4 caller) must
    still resolve to the exact legacy never-500 behavior."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/query", json={"question": "how does hybrid retrieval work?"})
    assert response.status_code == 200
    data = response.json()
    assert data["used_llm"] is False
    assert data["error"] is True


def test_api_query_unknown_mode_never_500s(tmp_path: Path) -> None:
    """An invalid `mode` string must degrade gracefully (per the existing
    never-500 contract), not crash the request."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/query", json={"question": "anything", "mode": "not-a-real-mode"})
    assert response.status_code == 200
    data = response.json()
    assert data["error"] is True


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
        reindex_graph(
            vault,
            store.conn,
            extraction_client=llm_client,
            embedder=store.embedder,
            vec_active=store.vec_active,
            model="mock",
            max_gleanings=0,
        )

    web_client = _client(vault)
    response = web_client.get("/api/graph", params={"mode": "entities"})
    assert response.status_code == 200
    data = response.json()
    assert any(node["label"] == "HYBRID SEARCH" and node["kind"] == "entity" for node in data["nodes"])


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
        reindex_graph(
            vault,
            store.conn,
            extraction_client=llm_client,
            embedder=store.embedder,
            vec_active=store.vec_active,
            model="mock",
            max_gleanings=0,
        )

    web_client = _client(vault)
    response = web_client.get("/api/graph", params={"mode": "both"})
    assert response.status_code == 200
    data = response.json()
    kinds = {node["kind"] for node in data["nodes"]}
    assert kinds == {"page", "entity"}


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
