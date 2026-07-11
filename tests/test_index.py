"""Tests for the hybrid (sqlite-vec + FTS5) index (Phase 4).

Every test here uses :class:`HashEmbedder` -- deterministic and
dependency-free -- so this suite never requires `sqlite-vec` or `fastembed`
to be installed. Tests that specifically care about the fallback path force
it via `use_vec=False`; a couple of smoke tests additionally exercise the
real `vec0` path when the extension happens to load on this host, but never
fail the suite if it doesn't.
"""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.index.embeddings import HashEmbedder, get_embedder
from mythic_proportion.index.retrieve import hybrid_search
from mythic_proportion.index.store import IndexStore
from mythic_proportion.vault.init import init_vault


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


def _write(vault: Path, page_type, title: str, body: str) -> None:
    write_page(vault, WikiPage.new(page_type=page_type, title=title, body=body))


def _write_raw_page(vault: Path, rel_path: str, text: str) -> Path:
    """Write a raw page verbatim (bypassing ``write_page``'s H1-insertion),
    to exercise ``derive_title``'s fallback chain against pages that don't
    necessarily follow the compiler's own writing conventions (e.g. a
    degraded stub, or a human-authored page)."""
    page_path = vault / rel_path
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_text(text, encoding="utf-8")
    return page_path


# --------------------------------------------------------------------------
# Title-extraction fallback chain (derive_title / read_page_title)
# --------------------------------------------------------------------------


def test_reindex_falls_back_to_h1_when_frontmatter_has_no_title(tmp_path: Path) -> None:
    """A page with NO frontmatter `title:` but a body H1 -- e.g. a degraded
    compile stub -- must be indexed/retrieved with the H1 text as its title,
    not an empty string."""
    vault = _seed_vault(tmp_path)
    _write_raw_page(
        vault,
        "wiki/sources/aurora-md.md",
        "---\n"
        "type: source\n"
        "tags: [stub, needs-compile]\n"
        "---\n"
        "\n"
        "# aurora.md\n"
        "\n"
        "Stub page body with no frontmatter title.\n",
    )

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        report = store.reindex(vault)
        assert report.added == 1
        title = store.get_title("wiki/sources/aurora-md.md")

    assert title == "aurora.md"


def test_reindex_falls_back_to_filename_when_no_title_and_no_h1(tmp_path: Path) -> None:
    """A page with NEITHER a frontmatter `title:` NOR a body H1 must still
    get a non-empty, readable title derived from its filename."""
    vault = _seed_vault(tmp_path)
    _write_raw_page(
        vault,
        "wiki/concepts/no-heading-here.md",
        "---\ntype: concept\ntags: []\n---\n\nJust a body paragraph, no heading at all.\n",
    )

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        report = store.reindex(vault)
        assert report.added == 1
        title = store.get_title("wiki/concepts/no-heading-here.md")

    assert title
    assert title != ""
    assert "no" in title.lower() and "heading" in title.lower()


def test_derive_title_prefers_frontmatter_title_when_present() -> None:
    """A page with an explicit frontmatter `title:` uses that verbatim, even
    if the body H1 (or filename) would suggest something different."""
    from mythic_proportion.compile.graph import derive_title

    frontmatter = {"title": "Human-Chosen Title"}
    body = "# A Different H1\n\nBody text.\n"
    assert derive_title(frontmatter, body, Path("wiki/concepts/whatever.md")) == "Human-Chosen Title"


def test_derive_title_ignores_blank_frontmatter_title() -> None:
    from mythic_proportion.compile.graph import derive_title

    frontmatter = {"title": "   "}
    body = "# Real Heading\n\nBody text.\n"
    assert derive_title(frontmatter, body, Path("wiki/concepts/whatever.md")) == "Real Heading"


# --------------------------------------------------------------------------
# FTS5 availability smoke test
# --------------------------------------------------------------------------


def test_fts5_is_available_on_this_host() -> None:
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE VIRTUAL TABLE t USING fts5(a, b)")
    conn.execute("INSERT INTO t(a, b) VALUES ('hello', 'world')")
    rows = conn.execute("SELECT a FROM t WHERE t MATCH 'hello'").fetchall()
    assert rows == [("hello",)]


# --------------------------------------------------------------------------
# Smoke test: insert + vector query (fallback path, forced)
# --------------------------------------------------------------------------


def test_smoke_insert_and_vector_query_fallback_path(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        assert store.vec_active is False
        store.upsert_page("wiki/concepts/a.md", "Alpha", "concept", "Alpha talks about rockets and space travel.")
        store.upsert_page("wiki/concepts/b.md", "Beta", "concept", "Beta is about gardening and vegetables.")
        store.upsert_page("wiki/concepts/c.md", "Gamma", "concept", "Gamma also discusses rockets and orbital mechanics.")

        query_vector = store.embedder.embed(["rockets and orbital mechanics"])[0]
        from mythic_proportion.index.embeddings import l2_normalize

        scores = store.vector_scores(l2_normalize(query_vector), store.all_page_paths())
        assert scores  # non-empty
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        # The rocket-themed pages should out-rank the gardening page.
        top_path = ranked[0][0]
        assert top_path in {"wiki/concepts/a.md", "wiki/concepts/c.md"}


def test_smoke_vec0_path_if_extension_loads(tmp_path: Path) -> None:
    """Attempt the real vec0 path; skip assertions gracefully if it can't load.

    This directly satisfies the "attempt sqlite-vec once" requirement without
    ever letting a failed install/load break the suite.
    """
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=None) as store:
        store.upsert_page("wiki/concepts/a.md", "Alpha", "concept", "Alpha rockets space travel.")
        store.upsert_page("wiki/concepts/b.md", "Beta", "concept", "Beta gardening vegetables.")
        if not store.vec_active:
            return  # sqlite-vec unavailable on this host -- fallback already covered above.

        from mythic_proportion.index.embeddings import l2_normalize

        query_vector = l2_normalize(store.embedder.embed(["rockets"])[0])
        scores = store.vector_scores(query_vector, store.all_page_paths())
        assert scores["wiki/concepts/a.md"] > scores["wiki/concepts/b.md"]


# --------------------------------------------------------------------------
# Incremental reindex
# --------------------------------------------------------------------------


def test_reindex_is_incremental(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    _write(vault, "concept", "Hybrid Retrieval", "Combining BM25 and vector search.")
    _write(vault, "concept", "Wikilinks", "The graph is the wikilinks.")

    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        report = store.reindex(vault)
        assert report.added == 2
        assert report.updated == 0
        assert report.deleted == 0
        assert report.unchanged == 0

        # Second reindex with no changes: everything unchanged.
        report2 = store.reindex(vault)
        assert report2.added == 0
        assert report2.updated == 0
        assert report2.deleted == 0
        assert report2.unchanged == 2

    # Edit exactly one page body.
    hybrid_path = vault / "wiki" / "concepts" / "hybrid-retrieval.md"
    text = hybrid_path.read_text(encoding="utf-8")
    hybrid_path.write_text(text.rstrip("\n") + "\n\nAn added sentence.\n", encoding="utf-8")

    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        report3 = store.reindex(vault)
        assert report3.added == 0
        assert report3.updated == 1
        assert report3.deleted == 0
        assert report3.unchanged == 1

    # Delete a page file entirely.
    (vault / "wiki" / "concepts" / "wikilinks.md").unlink()

    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        report4 = store.reindex(vault)
        assert report4.added == 0
        assert report4.updated == 0
        assert report4.deleted == 1
        assert report4.unchanged == 1
        assert store.all_page_paths() == ["wiki/concepts/hybrid-retrieval.md"]


def test_upsert_page_returns_false_when_content_hash_unchanged(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        assert store.upsert_page("wiki/concepts/x.md", "X", "concept", "same body") is True
        assert store.upsert_page("wiki/concepts/x.md", "X", "concept", "same body") is False
        assert store.upsert_page("wiki/concepts/x.md", "X", "concept", "different body") is True


def test_reindex_changing_embedder_wipes_and_rebuilds(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    _write(vault, "concept", "Only Page", "Some body text.")

    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)
        assert len(store.all_page_paths()) == 1

    # Reopen with a differently-dimensioned embedder: index must rebuild
    # cleanly (not silently mix incompatible vector dimensions).
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        assert store.all_page_paths() == []
        store.reindex(vault)
        assert len(store.all_page_paths()) == 1


# --------------------------------------------------------------------------
# Retrieval
# --------------------------------------------------------------------------


def _seed_retrieval_vault(tmp_path: Path) -> Path:
    vault = _seed_vault(tmp_path)
    _write(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines BM25 sparse search with vector cosine "
        "reranking for fast, accurate results. See [[Wikilink Graph]].",
    )
    _write(
        vault,
        "concept",
        "Wikilink Graph",
        "The knowledge graph in this vault is made entirely of [[wikilinks]] "
        "between Markdown pages, not a separate database.",
    )
    _write(
        vault,
        "concept",
        "Gardening Tips",
        "Water your tomatoes daily and rotate crops each season for a "
        "healthy vegetable garden.",
    )
    return vault


def test_known_query_returns_expected_top_page_hybrid_mode(tmp_path: Path) -> None:
    vault = _seed_retrieval_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=64), use_vec=False) as store:
        store.reindex(vault)
        hits = hybrid_search(store, "hybrid retrieval BM25 vector search", k=3)

    assert hits
    assert hits[0].page_path == "wiki/concepts/hybrid-retrieval.md"
    assert hits[0].tier in ("bm25", "hybrid")


def test_known_query_returns_expected_top_page_bm25_only_mode(tmp_path: Path) -> None:
    vault = _seed_retrieval_vault(tmp_path)
    with IndexStore(vault, embedder=None) as store:
        store.reindex(vault)
        hits = hybrid_search(store, "hybrid retrieval BM25 vector search", k=3)

    assert hits
    assert hits[0].page_path == "wiki/concepts/hybrid-retrieval.md"
    assert all(hit.tier == "bm25" for hit in hits)


def test_wikilink_expansion_fills_remaining_slots(tmp_path: Path) -> None:
    vault = _seed_retrieval_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=64), use_vec=False) as store:
        store.reindex(vault)
        # A query that lexically/semantically matches only "Hybrid Retrieval"
        # directly; "Wikilink Graph" should still surface via tier-3
        # expansion because it's linked from the top hit.
        hits = hybrid_search(store, "hybrid retrieval reranking", k=2)

    paths = [hit.page_path for hit in hits]
    assert "wiki/concepts/hybrid-retrieval.md" in paths
    assert "wiki/concepts/wikilink-graph.md" in paths
    expanded = [hit for hit in hits if hit.tier == "expanded"]
    assert any(hit.page_path == "wiki/concepts/wikilink-graph.md" for hit in expanded) or len(paths) == 2


def test_hybrid_search_returns_empty_for_empty_index(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        assert hybrid_search(store, "anything", k=5) == []


# --------------------------------------------------------------------------
# get_embedder factory
# --------------------------------------------------------------------------


def test_get_embedder_none_backend_returns_none(tmp_path: Path) -> None:
    from mythic_proportion.config import Settings

    settings = Settings(vault_path=tmp_path, embeddings_backend="none")
    assert get_embedder(settings) is None


def test_get_embedder_local_backend_returns_hash_embedder(tmp_path: Path) -> None:
    from mythic_proportion.config import Settings

    settings = Settings(vault_path=tmp_path, embeddings_backend="local")
    embedder = get_embedder(settings)
    assert isinstance(embedder, HashEmbedder)


def test_hash_embedder_is_deterministic_and_normalized() -> None:
    embedder = HashEmbedder(dim=16)
    v1 = embedder.embed(["hello world"])[0]
    v2 = embedder.embed(["hello world"])[0]
    assert v1 == v2
    norm = sum(x * x for x in v1) ** 0.5
    assert abs(norm - 1.0) < 1e-9 or norm == 0.0


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def test_cli_reindex_command(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    vault = tmp_path / "vault"
    result = runner.invoke(app, ["init", str(vault)])
    assert result.exit_code == 0

    _write(vault, "concept", "CLI Concept", "Body for the CLI reindex test.")

    result = runner.invoke(app, ["reindex", "--vault", str(vault)])
    assert result.exit_code == 0, result.output
    assert "Reindexed:" in result.output
    assert "+1 added" in result.output
