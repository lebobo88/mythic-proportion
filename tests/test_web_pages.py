"""Unit tests for `mythic_proportion.web.pages.collect_raw_sources` (the
Phase 3/4 GraphRAG extraction pipeline bugfix, DEFECT 2 -- "extraction reads
wiki/, not raw/").
"""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.vault.init import init_vault
from mythic_proportion.web.pages import collect_raw_sources


def _seed_drop_file(vault: Path, name: str, content: str) -> None:
    drop_dir = vault / "drop"
    drop_dir.mkdir(parents=True, exist_ok=True)
    (drop_dir / name).write_text(content, encoding="utf-8")


def test_collect_raw_sources_returns_empty_list_for_never_ingested_vault(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    init_vault(vault)
    assert collect_raw_sources(vault) == []


def test_collect_raw_sources_reads_real_ingested_content_not_compiled_wiki(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    init_vault(vault)
    _seed_drop_file(vault, "note.md", "The full uncompressed original source text.")
    report = ingest_drop(vault)
    assert not report.errors
    assert len(report.ingested) == 1

    sources = collect_raw_sources(vault)
    assert len(sources) == 1
    assert sources[0].body == "The full uncompressed original source text."
    assert sources[0].title == "note.md"
    assert sources[0].path.startswith("raw/")


def test_collect_raw_sources_covers_every_ledger_entry(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    init_vault(vault)
    _seed_drop_file(vault, "one.md", "First source.")
    _seed_drop_file(vault, "two.md", "Second source.")
    ingest_drop(vault)

    sources = collect_raw_sources(vault)
    assert {s.body for s in sources} == {"First source.", "Second source."}


def test_collect_raw_sources_skips_a_raw_file_removed_from_disk(tmp_path: Path) -> None:
    """A ledger entry whose `raw/` file has been moved/deleted since ingest
    must be skipped, not raise -- mirrors `ingest_drop`'s own
    never-abort-the-whole-run contract."""
    vault = tmp_path / "vault"
    init_vault(vault)
    _seed_drop_file(vault, "gone.md", "This will be deleted after ingest.")
    ingest_drop(vault)

    sources_before = collect_raw_sources(vault)
    assert len(sources_before) == 1
    raw_path = vault / sources_before[0].path
    raw_path.unlink()

    assert collect_raw_sources(vault) == []


def test_collect_raw_sources_works_with_a_relative_vault_path(tmp_path: Path, monkeypatch) -> None:
    """Regression test: the ledger stores `raw_path` in whatever form
    `ingest_drop` was originally called with (this test uses an absolute
    path, matching real CLI/web usage), but a LATER `collect_raw_sources`
    call may be given a *relative* `vault_root` (e.g. `mythic index-graph
    --vault playground` from the repo root) -- found via a live end-to-end
    run against a real vault. Both sides must be resolved before comparison
    instead of raising `ValueError` on a path-form mismatch."""
    vault = tmp_path / "vault"
    init_vault(vault)
    _seed_drop_file(vault, "note.md", "Relative-path regression content.")
    ingest_drop(vault)  # `vault` here is absolute -- matches real CLI/web usage

    monkeypatch.chdir(tmp_path)
    sources = collect_raw_sources(Path("vault"))  # relative vault_root
    assert len(sources) == 1
    assert sources[0].body == "Relative-path regression content."


def test_collect_raw_sources_is_independent_of_compile_wiki_output(tmp_path: Path) -> None:
    """Regardless of what (if anything) `wiki/` contains, `collect_raw_sources`
    only ever reflects `raw/` -- it never reads `wiki/` at all."""
    vault = tmp_path / "vault"
    init_vault(vault)
    _seed_drop_file(vault, "note.md", "Real, uncompressed content." * 50)
    ingest_drop(vault)  # `--no-compile` semantics: no wiki/ pages produced

    assert not (vault / "wiki" / "sources").is_dir() or not list((vault / "wiki" / "sources").glob("*.md"))
    sources = collect_raw_sources(vault)
    assert len(sources) == 1
    assert "Real, uncompressed content." in sources[0].body
