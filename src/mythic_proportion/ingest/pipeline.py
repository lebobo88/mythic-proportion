"""Orchestrate the drop -> parse -> dedup -> raw pipeline (Phase 2).

``ingest_drop`` walks ``<vault_root>/drop/``, classifies + hashes each file,
skips anything already recorded in the dedup ledger, parses new files via an
injectable parser registry (production code wires the real Docling/MarkItDown
adapters lazily; tests inject fakes), stages the parsed Markdown, moves the
immutable original into ``raw/<hash><ext>``, and records everything in the
ledger and the append-only ``wiki/log.md`` operation log.

A single bad file never aborts the run: errors are caught per-file and
collected into the returned :class:`IngestReport` alongside successes and
skips.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from mythic_proportion.ingest.dedup import Ledger, content_hash
from mythic_proportion.ingest.docling_adapter import parse_document, parse_image
from mythic_proportion.ingest.markitdown_adapter import (
    TEXT_DOCUMENT_EXTENSIONS,
    read_artifact_as_markdown,
    read_text_document,
)
from mythic_proportion.ingest.models import IngestedSource, IngestError, SourceKind
from mythic_proportion.ingest.router import classify, guess_mime

ParserRegistry = dict[SourceKind, Callable[[Path], str]]

ConflictPolicy = Literal["skip", "keep"]

LEDGER_RELATIVE_PATH = Path(".vault-meta") / "ingested.json"
STAGING_RELATIVE_DIR = Path(".vault-meta") / "staging"
LOG_RELATIVE_PATH = Path("wiki") / "log.md"


@dataclass
class SkippedEntry:
    """A dropped file that was skipped because its content was already ingested."""

    original_name: str
    content_hash: str
    existing_raw_path: str


@dataclass
class IngestErrorEntry:
    """A dropped file that failed to ingest, with the reason recorded."""

    original_name: str
    message: str


@dataclass
class IngestReport:
    """The full outcome of one ``ingest_drop`` run."""

    ingested: list[IngestedSource] = field(default_factory=list)
    skipped: list[SkippedEntry] = field(default_factory=list)
    errors: list[IngestErrorEntry] = field(default_factory=list)


def _parse_document(path: Path) -> str:
    """Dispatch document-kind parsing between the zero-dep text fast-path
    and Docling.

    Plain-text document formats (Markdown/txt/rst/org/tex/log) never need a
    parser at all — they are read directly as UTF-8 via
    :func:`read_text_document`. Rich/binary document formats (PDF/DOCX/PPTX/
    XLSX/ODT/RTF/HTML) still require Docling and legitimately raise
    :class:`~mythic_proportion.ingest.models.IngestDependencyError` when it
    is not installed.
    """
    if Path(path).suffix.lower() in TEXT_DOCUMENT_EXTENSIONS:
        return read_text_document(path)
    return parse_document(path)


def default_parser_registry() -> ParserRegistry:
    """Build the production parser registry, wired to the real adapters.

    Every adapter call is lazy under the hood (see ``docling_adapter`` /
    ``markitdown_adapter``), so simply *building* this registry never
    imports a heavy optional dependency — only invoking a parser does.
    """
    return {
        "document": _parse_document,
        "image": parse_image,
        "artifact": read_artifact_as_markdown,
    }


def _iter_drop_files(drop_dir: Path) -> list[Path]:
    if not drop_dir.is_dir():
        return []
    files = [
        p
        for p in sorted(drop_dir.iterdir())
        if p.is_file() and not p.name.startswith(".")
    ]
    return files


def _append_log(log_path: Path, lines: list[str]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not log_path.exists():
        log_path.write_text("# Ingestion log\n\n", encoding="utf-8")
    with log_path.open("a", encoding="utf-8") as f:
        for line in lines:
            f.write(line + "\n")


def ingest_drop(
    vault_root: Path,
    *,
    parser_registry: ParserRegistry | None = None,
    on_conflict: ConflictPolicy = "skip",
) -> IngestReport:
    """Ingest every file currently in ``<vault_root>/drop/``.

    ``on_conflict`` governs what happens to a dropped file whose content hash
    is already in the ledger:

    * ``"skip"`` (default) — remove the duplicate from ``drop/`` after
      logging the skip (the content is already preserved in ``raw/``).
    * ``"keep"`` — leave the duplicate file in ``drop/`` untouched for manual
      resolution; only the skip is logged.
    """
    vault_root = Path(vault_root)
    drop_dir = vault_root / "drop"
    raw_dir = vault_root / "raw"
    staging_dir = vault_root / STAGING_RELATIVE_DIR
    ledger = Ledger(vault_root / LEDGER_RELATIVE_PATH)
    log_path = vault_root / LOG_RELATIVE_PATH
    registry = parser_registry or default_parser_registry()

    report = IngestReport()
    log_lines: list[str] = []
    now = datetime.now(timezone.utc)

    for path in _iter_drop_files(drop_dir):
        try:
            hashed = content_hash(path)
            existing = ledger.get(hashed)
            if existing is not None:
                report.skipped.append(
                    SkippedEntry(
                        original_name=path.name,
                        content_hash=hashed,
                        existing_raw_path=existing["raw_path"],
                    )
                )
                log_lines.append(
                    f"- {now.isoformat()} SKIPPED (duplicate) {path.name} ({hashed[:12]})"
                )
                if on_conflict == "skip":
                    path.unlink()
                continue

            kind = classify(path)
            parser = registry.get(kind)
            if parser is None:
                raise IngestError(f"no parser registered for kind {kind!r}")

            parsed_markdown = parser(path)

            staging_dir.mkdir(parents=True, exist_ok=True)
            staging_path = staging_dir / f"{hashed}.md"
            staging_path.write_text(parsed_markdown, encoding="utf-8")

            raw_dir.mkdir(parents=True, exist_ok=True)
            ext = path.suffix
            raw_path = raw_dir / f"{hashed}{ext}"
            shutil.move(str(path), str(raw_path))

            mime = guess_mime(path)
            size = raw_path.stat().st_size

            source = IngestedSource(
                original_name=path.name,
                content_hash=hashed,
                raw_path=raw_path,
                kind=kind,
                parsed_markdown=parsed_markdown,
                mime=mime,
                bytes=size,
                ingested_at=now,
                metadata={"staging_path": str(staging_path)},
            )
            report.ingested.append(source)

            ledger.record(
                hashed,
                original_name=path.name,
                raw_path=raw_path,
                kind=kind,
                ingested_at=now,
            )
            log_lines.append(
                f"- {now.isoformat()} INGESTED {path.name} ({hashed[:12]}) kind={kind}"
            )
        except Exception as exc:  # noqa: BLE001 - a single bad file must never abort the run
            report.errors.append(IngestErrorEntry(original_name=path.name, message=str(exc)))
            log_lines.append(f"- {now.isoformat()} ERROR {path.name}: {exc}")

    if log_lines:
        _append_log(log_path, log_lines)

    return report
