"""Tests for ingest/pipeline.py using fake parsers (Phase 2).

No heavy dependency (Docling/MarkItDown) is installed or imported anywhere
in this file — every parser is a fake injected via ``parser_registry``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mythic_proportion.ingest.dedup import Ledger, content_hash
from mythic_proportion.ingest.pipeline import (
    LEDGER_RELATIVE_PATH,
    LOG_RELATIVE_PATH,
    ingest_drop,
)
from mythic_proportion.ingest.models import IngestDependencyError
from mythic_proportion.vault.init import init_vault


def _fake_registry() -> dict:
    return {
        "document": lambda path: f"# parsed document: {Path(path).name}\n",
        "image": lambda path: f"# parsed image: {Path(path).name}\n",
        "artifact": lambda path: f"# parsed artifact: {Path(path).name}\n",
    }


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


def test_ingest_drop_with_fake_registry_files_all_three_kinds(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    drop = vault / "drop"

    pdf = drop / "report.pdf"
    png = drop / "screenshot.png"
    js = drop / "data.json"
    pdf.write_bytes(b"%PDF-1.4 fake pdf bytes")
    png.write_bytes(b"\x89PNG fake png bytes")
    js.write_text('{"key": "value"}', encoding="utf-8")

    expected_hashes = {p.name: content_hash(p) for p in (pdf, png, js)}

    report = ingest_drop(vault, parser_registry=_fake_registry())

    assert len(report.ingested) == 3
    assert not report.skipped
    assert not report.errors

    # drop/ is emptied
    assert list(drop.iterdir()) == []

    # each original lands immutably in raw/<hash><ext>
    for name, ext in (("report.pdf", ".pdf"), ("screenshot.png", ".png"), ("data.json", ".json")):
        h = expected_hashes[name]
        raw_path = vault / "raw" / f"{h}{ext}"
        assert raw_path.is_file(), f"expected {raw_path} to exist"

        staging_path = vault / ".vault-meta" / "staging" / f"{h}.md"
        assert staging_path.is_file(), f"expected staging markdown {staging_path} to exist"
        assert name in staging_path.read_text(encoding="utf-8")

    # Ledger has exactly 3 entries
    ledger = Ledger(vault / LEDGER_RELATIVE_PATH)
    assert len(ledger) == 3
    for h in expected_hashes.values():
        assert ledger.already_ingested(h)

    # log.md was updated
    log_text = (vault / LOG_RELATIVE_PATH).read_text(encoding="utf-8")
    assert "INGESTED report.pdf" in log_text
    assert "INGESTED screenshot.png" in log_text
    assert "INGESTED data.json" in log_text

    kinds = {source.original_name: source.kind for source in report.ingested}
    assert kinds["report.pdf"] == "document"
    assert kinds["screenshot.png"] == "image"
    assert kinds["data.json"] == "artifact"


def test_ingest_drop_dedups_same_file_across_two_runs(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    drop = vault / "drop"
    f1 = drop / "note.txt"
    f1.write_text("identical content", encoding="utf-8")

    first_report = ingest_drop(vault, parser_registry=_fake_registry())
    assert len(first_report.ingested) == 1
    assert not first_report.skipped

    # Drop the exact same content again under a different name.
    f2 = drop / "note-copy.txt"
    f2.write_text("identical content", encoding="utf-8")

    second_report = ingest_drop(vault, parser_registry=_fake_registry())
    assert len(second_report.ingested) == 0
    assert len(second_report.skipped) == 1
    assert second_report.skipped[0].original_name == "note-copy.txt"

    # Only one raw/ entry total for this content hash.
    raw_files = list((vault / "raw").iterdir())
    assert len(raw_files) == 1

    # Default on_conflict="skip" removes the duplicate from drop/.
    assert list(drop.iterdir()) == []

    # The skip was logged.
    log_text = (vault / LOG_RELATIVE_PATH).read_text(encoding="utf-8")
    assert "SKIPPED (duplicate) note-copy.txt" in log_text


def test_ingest_drop_keeps_duplicate_when_on_conflict_keep(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    drop = vault / "drop"
    f1 = drop / "note.txt"
    f1.write_text("identical content", encoding="utf-8")
    ingest_drop(vault, parser_registry=_fake_registry())

    f2 = drop / "note-copy.txt"
    f2.write_text("identical content", encoding="utf-8")
    report = ingest_drop(vault, parser_registry=_fake_registry(), on_conflict="keep")

    assert len(report.skipped) == 1
    assert f2.is_file()  # left in place for manual resolution


def test_ingest_drop_records_parser_failure_as_error_and_continues(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    drop = vault / "drop"
    good = drop / "good.json"
    bad = drop / "corrupt.json"
    good.write_text('{"ok": true}', encoding="utf-8")
    bad.write_text("not actually valid json but that's fine, parser will reject it", encoding="utf-8")

    def flaky_artifact_parser(path: Path) -> str:
        if "corrupt" in Path(path).name:
            raise ValueError("simulated corrupt-file parse failure")
        return f"# parsed artifact: {Path(path).name}\n"

    registry = _fake_registry()
    registry["artifact"] = flaky_artifact_parser

    report = ingest_drop(vault, parser_registry=registry)

    assert len(report.ingested) == 1
    assert report.ingested[0].original_name == "good.json"
    assert len(report.errors) == 1
    assert report.errors[0].original_name == "corrupt.json"
    assert "simulated corrupt-file parse failure" in report.errors[0].message

    # the corrupt file is left in place (never moved/deleted) since it errored
    assert bad.exists()

    log_text = (vault / LOG_RELATIVE_PATH).read_text(encoding="utf-8")
    assert "ERROR corrupt.json" in log_text


def test_ingest_drop_empty_drop_folder_is_a_no_op(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    report = ingest_drop(vault, parser_registry=_fake_registry())
    assert report.ingested == []
    assert report.skipped == []
    assert report.errors == []


def test_ingest_drop_skips_dotfiles(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    drop = vault / "drop"
    (drop / ".DS_Store").write_bytes(b"junk")
    report = ingest_drop(vault, parser_registry=_fake_registry())
    assert report.ingested == []
    assert (drop / ".DS_Store").exists()


def test_default_parser_registry_document_raises_dependency_error_without_docling() -> None:
    from mythic_proportion.ingest.pipeline import default_parser_registry

    registry = default_parser_registry()
    with pytest.raises(IngestDependencyError):
        registry["document"](Path("nonexistent.pdf"))


def test_default_parser_registry_ingests_plain_text_documents_with_zero_deps(
    tmp_path: Path,
) -> None:
    """Regression test: plain-text documents must ingest with no heavy deps.

    Uses the REAL ``default_parser_registry()`` (not a fake) so it actually
    exercises the docling/markitdown lazy-import guard. A ``.md`` and a
    ``.txt`` must both ingest successfully; a ``.pdf`` must still legitimately
    raise ``IngestDependencyError`` since binary formats genuinely need
    Docling.
    """
    from mythic_proportion.ingest.pipeline import default_parser_registry

    vault = _seed_vault(tmp_path)
    drop = vault / "drop"

    md = drop / "aurora.md"
    md.write_text("# Aurora\n\nSome **real** markdown content.\n", encoding="utf-8")
    txt = drop / "notes.txt"
    txt.write_text("plain text notes, nothing fancy", encoding="utf-8")

    report = ingest_drop(vault, parser_registry=default_parser_registry())

    assert not report.errors, report.errors
    assert len(report.ingested) == 2

    kinds = {source.original_name: source for source in report.ingested}
    assert kinds["aurora.md"].kind == "document"
    assert kinds["notes.txt"].kind == "document"

    # Markdown is passed through raw (unwrapped).
    assert kinds["aurora.md"].parsed_markdown == "# Aurora\n\nSome **real** markdown content.\n"
    # Plain .txt is lightly wrapped but the original content survives.
    assert "plain text notes, nothing fancy" in kinds["notes.txt"].parsed_markdown

    # drop/ is emptied; both originals preserved in raw/
    assert list(drop.iterdir()) == []
    assert len(list((vault / "raw").iterdir())) == 2


def test_default_parser_registry_document_pdf_still_requires_docling(
    tmp_path: Path,
) -> None:
    """A real binary document (PDF) legitimately still needs Docling."""
    from mythic_proportion.ingest.pipeline import default_parser_registry

    vault = _seed_vault(tmp_path)
    drop = vault / "drop"
    pdf = drop / "report.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake pdf bytes")

    report = ingest_drop(vault, parser_registry=default_parser_registry())

    assert not report.ingested
    assert len(report.errors) == 1
    assert report.errors[0].original_name == "report.pdf"
    assert "pip install" in report.errors[0].message
