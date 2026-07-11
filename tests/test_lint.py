"""Tests for the vault health check (Phase 5)."""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.compile.models import WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.index.embeddings import HashEmbedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.vault.init import init_vault
from mythic_proportion.vault.lint import lint_fix, lint_vault


def _write(vault: Path, page_type: str, title: str, body: str) -> None:
    write_page(vault, WikiPage.new(page_type=page_type, title=title, body=body))


def _seed_clean_vault(tmp_path: Path) -> Path:
    """A vault with two mutually-linked pages -- no orphans, no broken links."""
    vault = tmp_path / "vault"
    init_vault(vault)
    _write(
        vault,
        "concept",
        "Hybrid Retrieval",
        "Hybrid retrieval combines BM25 and vector search. See [[Wikilink Graph]] "
        "for how the pages themselves form the knowledge graph via wikilinks.",
    )
    _write(
        vault,
        "concept",
        "Wikilink Graph",
        "The graph is made of [[Hybrid Retrieval]]-indexed wikilinks between pages, "
        "not a separate database, which keeps everything human-readable.",
    )
    return vault


def test_clean_vault_lints_ok(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    report = lint_vault(vault)

    assert report.ok is True
    assert report.exit_code == 0
    assert report.orphans == []
    assert report.dangling_links == []
    assert "clean" in report.summary().lower()


def test_orphan_and_broken_link_detected(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)

    # (a) an orphan page: no inbound, no outbound links.
    _write(vault, "concept", "Lonely Island", "This page links to nothing and is linked by nothing.")

    # (b) a page with a broken/dangling wikilink.
    _write(
        vault,
        "concept",
        "Has A Broken Link",
        "This page references [[Nonexistent]], which does not exist yet.",
    )

    report = lint_vault(vault)

    assert report.ok is False
    assert report.exit_code != 0

    orphan_titles = {o.title for o in report.orphans}
    assert "Lonely Island" in orphan_titles

    dangling_targets = {d.target_title for d in report.dangling_links}
    assert "Nonexistent" in dangling_targets
    broken = next(d for d in report.dangling_links if d.target_title == "Nonexistent")
    assert broken.source_title == "Has A Broken Link"

    summary = report.summary()
    assert "Lonely Island" in summary
    assert "Nonexistent" in summary


def test_lint_fix_creates_stub_and_resolves_broken_link(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    _write(
        vault,
        "concept",
        "Has A Broken Link",
        "This page references [[Nonexistent]], which does not exist yet.",
    )

    report = lint_vault(vault)
    assert any(d.target_title == "Nonexistent" for d in report.dangling_links)

    fix_result = lint_fix(vault)
    assert "Nonexistent" in fix_result.stubs_created

    stub_path = vault / "wiki" / "concepts" / "nonexistent.md"
    assert stub_path.is_file()

    report_after = lint_vault(vault)
    assert not any(d.target_title == "Nonexistent" for d in report_after.dangling_links)


def test_stale_index_entry_missing_on_disk(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    (vault / "wiki" / "concepts" / "hybrid-retrieval.md").unlink()

    report = lint_vault(vault)
    reasons = {(s.page_path, s.reason) for s in report.stale_index_entries}
    assert ("wiki/concepts/hybrid-retrieval.md", "missing_on_disk") in reasons
    assert report.ok is False


def test_stale_index_entry_content_changed(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    with IndexStore(vault, HashEmbedder(dim=16), use_vec=False) as store:
        store.reindex(vault)

    path = vault / "wiki" / "concepts" / "hybrid-retrieval.md"
    path.write_text(path.read_text(encoding="utf-8") + "\nAn added sentence.\n", encoding="utf-8")

    report = lint_vault(vault)
    reasons = {(s.page_path, s.reason) for s in report.stale_index_entries}
    assert ("wiki/concepts/hybrid-retrieval.md", "content_changed") in reasons


def test_no_index_yet_reports_no_stale_entries(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    report = lint_vault(vault)
    assert report.stale_index_entries == []


def test_thin_page_flagged_and_stub_excluded(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    _write(vault, "concept", "Too Short", "x")  # thin body, no tags

    report = lint_vault(vault)
    thin_titles = {t.title for t in report.thin_pages}
    assert "Too Short" in thin_titles


def test_graph_created_stub_not_flagged_thin_but_needs_compile_stub_is(tmp_path: Path) -> None:
    vault = _seed_clean_vault(tmp_path)
    _write(
        vault,
        "concept",
        "Points At Ghost",
        "This links to [[Ghost Page]] which does not exist yet.",
    )
    lint_fix(vault)  # creates a tagged-"stub" page for "Ghost Page"

    # A needs-compile stub (the kind a compile-time fallback would once have
    # written) carries both "stub" and "needs-compile" tags.
    needs_compile_page = WikiPage.new(
        page_type="source",
        title="raw-note.txt",
        body="**Stub page** — created without LLM compilation.\n\n## Excerpt\n\na short raw excerpt\n",
        tags=["stub", "needs-compile"],
        source_hash="deadbeef" * 8,
    )
    write_page(vault, needs_compile_page)

    report = lint_vault(vault)
    thin_titles = {t.title for t in report.thin_pages}

    assert "Ghost Page" not in thin_titles  # plain graph-created stub -- excluded
    assert "raw-note.txt" in thin_titles  # needs-compile stub -- flagged


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def test_cli_lint_reports_nonzero_and_fix_resolves(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    vault = _seed_clean_vault(tmp_path)
    _write(
        vault,
        "concept",
        "Has A Broken Link",
        "This page references [[Nonexistent]], which does not exist yet.",
    )

    result = runner.invoke(app, ["lint", str(vault)])
    assert result.exit_code != 0
    assert "Broken wikilinks" in result.output

    result_fixed = runner.invoke(app, ["lint", str(vault), "--fix"])
    assert "Fix applied" in result_fixed.output
    assert (vault / "wiki" / "concepts" / "nonexistent.md").is_file()


def test_cli_lint_clean_vault_exits_zero(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    vault = _seed_clean_vault(tmp_path)

    result = runner.invoke(app, ["lint", str(vault)])
    assert result.exit_code == 0, result.output
    assert "clean" in result.output.lower()


def test_cli_lint_help() -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    result = runner.invoke(app, ["lint", "--help"])
    assert result.exit_code == 0, result.output
    assert "--fix" in result.output
