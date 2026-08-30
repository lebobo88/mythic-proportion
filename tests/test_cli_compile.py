"""CLI wiring test for `mythic ingest --compile/--no-compile` (Phase 3;
LLM-required as of the AuthHub migration -- a missing provider now surfaces a
clean per-source error line rather than a degraded stub page, and ingest
still exits 0)."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from mythic_proportion.cli.app import app

runner = CliRunner()


def test_ingest_default_compile_with_no_provider_refuses_before_ingesting(
    tmp_path: Path, monkeypatch
) -> None:
    """`ingest --compile` with no usable LLM must abort BEFORE ingesting anything.

    Regression test for the stranded-vault trap: `ingest_drop` records a
    content hash in the dedup ledger before compile runs and never rolls it
    back, so ingesting first and failing to compile left the source
    ingested-but-uncompiled -- and re-dropping the same file was then
    correctly reported as a duplicate, making it unrecoverable through the
    normal UI. Nothing may be written unless compile can actually run.
    """
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = tmp_path / "vault"
    result = runner.invoke(app, ["init", str(vault)])
    assert result.exit_code == 0

    # Use an "artifact" kind file (.json) so ingest needs no optional heavy
    # dependency (Docling/MarkItDown) -- this test only exercises the CLI's
    # compile wiring, not Phase 2 document parsing.
    dropped = vault / "drop" / "note.json"
    dropped.write_text('{"hello": "from the CLI"}', encoding="utf-8")

    result = runner.invoke(app, ["ingest", str(vault)])
    assert result.exit_code == 1, result.output
    assert "AUTHHUB_API_KEY" in result.output
    assert "Traceback" not in result.output

    # The file is still in drop/, still retryable, and nothing was recorded.
    assert dropped.is_file()
    assert list((vault / "raw").glob("*")) == []
    assert not (vault / ".vault-meta" / "ingested.json").is_file()
    assert list((vault / "wiki" / "sources").glob("*.md")) == []


def test_ingest_no_compile_skips_compile_step(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    runner.invoke(app, ["init", str(vault)])
    (vault / "drop" / "note.json").write_text('{"hello": "world"}', encoding="utf-8")

    result = runner.invoke(app, ["ingest", str(vault), "--no-compile"])
    assert result.exit_code == 0, result.output
    assert "Compiling" not in result.output

    stub_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(stub_pages) == 0
