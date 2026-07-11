"""CLI wiring test for `mythic ingest --compile/--no-compile` (Phase 3;
LLM-required as of the AuthHub migration -- a missing provider now surfaces a
clean per-source error line rather than a degraded stub page, and ingest
still exits 0)."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from mythic_proportion.cli.app import app

runner = CliRunner()


def test_ingest_default_compile_with_no_provider_reports_clean_error(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = tmp_path / "vault"
    result = runner.invoke(app, ["init", str(vault)])
    assert result.exit_code == 0

    # Use an "artifact" kind file (.json) so ingest needs no optional heavy
    # dependency (Docling/MarkItDown) -- this test only exercises the CLI's
    # compile wiring, not Phase 2 document parsing.
    (vault / "drop" / "note.json").write_text('{"hello": "from the CLI"}', encoding="utf-8")

    result = runner.invoke(app, ["ingest", str(vault)])
    assert result.exit_code == 0, result.output
    assert "Ingested: 1" in result.output
    assert "Compiling: 1" in result.output
    assert "AUTHHUB_API_KEY" in result.output
    assert "Traceback" not in result.output

    # No page was written for the failed compile -- no more silent stub.
    stub_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(stub_pages) == 0


def test_ingest_no_compile_skips_compile_step(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    runner.invoke(app, ["init", str(vault)])
    (vault / "drop" / "note.json").write_text('{"hello": "world"}', encoding="utf-8")

    result = runner.invoke(app, ["ingest", str(vault), "--no-compile"])
    assert result.exit_code == 0, result.output
    assert "Compiling" not in result.output

    stub_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(stub_pages) == 0
