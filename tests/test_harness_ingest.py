"""Tests for the Phase 6 harness-aware ingest recipe (optional convenience)."""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.harness_ingest import collect_harness_sources, ingest_harness
from mythic_proportion.vault.init import init_vault


def _seed_fake_harness(root: Path) -> Path:
    """Seed a fake harness tree using artifact-kind extensions (.json) rather
    than document-kind ones (.md/.html) so ingest tests never require the
    optional heavy Docling dependency -- same pattern as test_cli_compile.py.
    """
    harness = root / "harness"
    (harness / "specs").mkdir(parents=True)
    (harness / "memory").mkdir(parents=True)
    (harness / ".fable" / "artifacts").mkdir(parents=True)

    (harness / "specs" / "plan.json").write_text('{"plan": "value"}', encoding="utf-8")
    (harness / "memory" / "invariants.json").write_text('{"invariant": "value"}', encoding="utf-8")
    (harness / ".fable" / "artifacts" / "4.3-spec.json").write_text('{"spec": "artifact"}', encoding="utf-8")
    return harness


def test_collect_harness_sources_copies_specs_memory_and_fable(tmp_path: Path) -> None:
    harness = _seed_fake_harness(tmp_path)
    vault = tmp_path / "vault"
    init_vault(vault)

    report = collect_harness_sources(harness, vault)

    assert not report.skipped_missing
    names = {p.name for p in report.copied}
    assert "specs__plan.json" in names
    assert "memory__invariants.json" in names
    assert "fable__artifacts__4.3-spec.json" in names

    for path in report.copied:
        assert path.parent == vault / "drop"
        assert path.is_file()


def test_collect_harness_sources_records_missing_dirs(tmp_path: Path) -> None:
    harness = tmp_path / "empty-harness"
    harness.mkdir()
    vault = tmp_path / "vault"
    init_vault(vault)

    report = collect_harness_sources(harness, vault)

    assert set(report.skipped_missing) == {"specs/", "memory/", ".fable/"}
    assert report.copied == []


def test_collect_harness_sources_does_not_mutate_the_harness(tmp_path: Path) -> None:
    """Copy, never move -- the harness's own copies must be left untouched."""
    harness = _seed_fake_harness(tmp_path)
    vault = tmp_path / "vault"
    init_vault(vault)

    collect_harness_sources(harness, vault)

    assert (harness / "specs" / "plan.json").is_file()
    assert (harness / "memory" / "invariants.json").is_file()
    assert (harness / ".fable" / "artifacts" / "4.3-spec.json").is_file()


def test_ingest_harness_collects_and_ingests_in_one_call(tmp_path: Path) -> None:
    harness = _seed_fake_harness(tmp_path)
    vault = tmp_path / "vault"
    init_vault(vault)

    collect_report, ingest_report = ingest_harness(harness, vault)

    assert len(collect_report.copied) == 3
    assert len(ingest_report.ingested) == 3
    assert list((vault / "drop").iterdir()) == []  # ingest_drop emptied drop/
    assert not ingest_report.errors


def test_ingest_harness_respects_fable_artifact_limit(tmp_path: Path) -> None:
    harness = tmp_path / "harness"
    (harness / ".fable" / "artifacts").mkdir(parents=True)
    for i in range(5):
        (harness / ".fable" / "artifacts" / f"artifact-{i}.md").write_text(f"content {i}", encoding="utf-8")

    vault = tmp_path / "vault"
    init_vault(vault)

    report = collect_harness_sources(harness, vault, fable_artifact_limit=2)
    assert len(report.copied) == 2


def test_ingest_harness_does_not_compile_by_default(tmp_path: Path) -> None:
    harness = _seed_fake_harness(tmp_path)
    vault = tmp_path / "vault"
    init_vault(vault)

    ingest_harness(harness, vault)

    assert list((vault / "wiki" / "sources").glob("*.md")) == []


# --------------------------------------------------------------------------
# CLI wiring (hidden `ingest-harness` command)
# --------------------------------------------------------------------------


def test_cli_ingest_harness_hidden_command(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    harness = _seed_fake_harness(tmp_path)
    vault = tmp_path / "vault"
    init_vault(vault)

    runner = CliRunner()
    result = runner.invoke(
        app, ["ingest-harness", "--harness-root", str(harness), "--vault", str(vault)]
    )
    assert result.exit_code == 0, result.output
    assert "Collected: 3" in result.output
    assert "Ingested: 3" in result.output


def test_cli_ingest_harness_hidden_from_help() -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0, result.output
    assert "ingest-harness" not in result.output
