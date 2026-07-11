"""Docling-backed parsing for documents and images.

Docling is a heavy, optional dependency (IBM, MIT license) pulled in only via
the ``mythic-proportion[ingest]`` extra. This module never imports ``docling``
at module load time — the import happens lazily, inside each function, only
when the caller actually needs to parse a file. If Docling isn't installed,
callers get a clear, actionable :class:`IngestDependencyError` instead of a
raw ``ImportError`` surfacing from deep inside the pipeline.
"""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.ingest.models import IngestDependencyError

_INSTALL_HINT = "pip install 'mythic-proportion[ingest]'"


def _require_docling() -> object:
    try:
        import docling  # noqa: F401  (imported for its side effect: availability check)
    except ImportError as exc:  # pragma: no cover - exercised only when docling absent
        raise IngestDependencyError(_INSTALL_HINT) from exc
    return docling


def parse_document(path: Path) -> str:
    """Parse a document (PDF/DOCX/PPTX/XLSX/...) into unified Markdown via Docling.

    Raises :class:`IngestDependencyError` if Docling is not installed.
    """
    _require_docling()
    from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]

    converter = DocumentConverter()
    result = converter.convert(str(path))
    return str(result.document.export_to_markdown())


def parse_image(path: Path) -> str:
    """Parse an image (OCR + vision captioning) into Markdown via Docling.

    Raises :class:`IngestDependencyError` if Docling is not installed.
    """
    _require_docling()
    from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]

    converter = DocumentConverter()
    result = converter.convert(str(path))
    return str(result.document.export_to_markdown())
