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


def test_ingest_drop_called_with_a_relative_vault_root_does_not_double_prepend_later(
    tmp_path: Path, monkeypatch
) -> None:
    """Regression for the T2 job's readiness-phase finding: `ingest_drop`
    itself (not just `collect_raw_sources`) can be called with a *relative*
    `vault_root` -- e.g. `mythic serve --vault demo-vault` run from the
    parent directory rather than from inside the vault. Before the fix,
    `ingest_drop` used that relative `vault_root` as-is to build `raw_dir`
    (`vault_root / "raw"`), so the ledger recorded a CWD-relative path like
    `demo-vault/raw/<hash>.md` -- a path that happens to be PREFIXED with
    the vault's own directory name, not truly vault-relative. A later
    `collect_raw_sources(vault_root)` call resolves `vault_root` to its
    absolute form and, seeing the ledger's `raw_path` isn't absolute,
    reconstructs it as `vault_root / raw_path` -- which double-prepends the
    vault directory name (`.../demo-vault/demo-vault/raw/<hash>.md`) and
    silently finds nothing, producing zero text units with no error
    surfaced. Fixed by resolving `vault_root` to absolute at the top of
    `ingest_drop`, so every `raw_path` it ever records is unambiguous."""
    monkeypatch.chdir(tmp_path)
    vault_name = "demo-vault"
    vault = tmp_path / vault_name
    init_vault(vault)
    _seed_drop_file(vault, "note.md", "Relative --vault regression content.")

    # The exact repro shape: `--vault demo-vault` from the *parent* of the
    # vault directory, not `--vault .` from inside it.
    ingest_report = ingest_drop(Path(vault_name))
    assert not ingest_report.errors
    assert len(ingest_report.ingested) == 1

    sources = collect_raw_sources(Path(vault_name))
    assert len(sources) == 1, (
        "collect_raw_sources found zero text units -- the double-prepend bug is back"
    )
    assert sources[0].body == "Relative --vault regression content."


def test_collect_raw_sources_heals_a_pre_existing_legacy_broken_ledger_entry(tmp_path: Path) -> None:
    """Codex J-004 (remediation cycle on the `ingest_drop` vault_root fix
    above): that fix only prevents *new* ledger writes from recording the
    broken CWD-relative-but-vault-prefixed `raw_path` shape -- it does
    nothing for a vault that was ALREADY ingested by the old buggy code
    before the fix landed. This constructs a ledger entry in exactly that
    legacy broken shape directly (bypassing `ingest_drop` entirely, since
    the fixed `ingest_drop` can no longer produce it) and confirms
    `collect_raw_sources` now heals it instead of silently finding nothing."""
    from mythic_proportion.ingest.dedup import Ledger, content_hash
    from mythic_proportion.ingest.pipeline import LEDGER_RELATIVE_PATH

    vault_name = "vault"
    vault = tmp_path / vault_name
    init_vault(vault)

    raw_dir = vault / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    content = "Content ingested by the old, pre-fix relative-vault-root code path."
    hashed = content_hash(content.encode("utf-8"))
    raw_file = raw_dir / f"{hashed}.md"
    raw_file.write_text(content, encoding="utf-8")

    # The exact legacy broken shape: CWD-relative, vault-name-prefixed --
    # what `ingest_drop(Path("vault"))` would have recorded before this
    # job's fix (see the double-prepend regression test above).
    ledger = Ledger(vault / LEDGER_RELATIVE_PATH)
    ledger.record(
        hashed,
        original_name="legacy-note.md",
        raw_path=Path(vault_name) / "raw" / f"{hashed}.md",
        kind="document",
    )

    sources = collect_raw_sources(vault)
    assert len(sources) == 1, "the legacy-shaped ledger entry was not healed"
    assert sources[0].body == content
    assert sources[0].title == "legacy-note.md"


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
