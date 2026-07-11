"""MarkItDown fast-path parsing, plus no-dependency text/artifact readers.

Three distinct paths live here:

* :func:`parse_simple` — for simple Office/HTML/CSV documents where a fast,
  deterministic converter (MarkItDown) is preferable to Docling's heavier
  ML pipeline. MarkItDown is lazy-imported, exactly like Docling.
* :func:`read_artifact_as_markdown` — for code/JSON/YAML/TOML/text/log
  artifacts, which need no external dependency at all: they are read as
  UTF-8 text directly and fenced as a Markdown code block.
* :func:`read_text_document` — for plain-text *document*-kind sources
  (Markdown/txt/rst/org/tex/log). These need no parser at all — Docling
  would be overkill and, when absent, wrongly blocks ingestion of files
  that were never binary in the first place. Markdown-family extensions
  are passed through verbatim (they are already valid Markdown); other
  plain-text formats are lightly wrapped in a fenced code block.
"""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.ingest.models import IngestDependencyError

_INSTALL_HINT = "pip install 'mythic-proportion[ingest]'"

# Extensions MarkItDown can fence-language-hint for artifact rendering.
_ARTIFACT_LANG_HINTS: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".csv": "csv",
    ".log": "text",
    ".sh": "bash",
    ".sql": "sql",
    ".md": "markdown",
    ".txt": "text",
}

# Plain-text *document*-kind extensions that never need Docling/MarkItDown —
# they are read directly as UTF-8. Markdown-family extensions are passed
# through unchanged; the rest are lightly wrapped in a fenced code block.
TEXT_DOCUMENT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".md",
        ".markdown",
        ".txt",
        ".text",
        ".rst",
        ".org",
        ".tex",
        ".log",
    }
)

_MARKDOWN_PASSTHROUGH_EXTENSIONS: frozenset[str] = frozenset({".md", ".markdown"})


def _require_markitdown() -> object:
    try:
        import markitdown  # noqa: F401  (imported for its side effect: availability check)
    except ImportError as exc:  # pragma: no cover - exercised only when markitdown absent
        raise IngestDependencyError(_INSTALL_HINT) from exc
    return markitdown


def parse_simple(path: Path) -> str:
    """Fast deterministic Markdown conversion for docx/pptx/xlsx/html/csv.

    Raises :class:`IngestDependencyError` if MarkItDown is not installed.
    """
    _require_markitdown()
    from markitdown import MarkItDown  # type: ignore[import-not-found]

    converter = MarkItDown()
    result = converter.convert(str(path))
    return str(result.text_content)


def read_artifact_as_markdown(path: Path) -> str:
    """Read a code/config/text artifact as UTF-8 and fence it as Markdown.

    No external dependency required — this is the always-available path for
    artifact-kind sources.
    """
    path = Path(path)
    lang = _ARTIFACT_LANG_HINTS.get(path.suffix.lower(), "")
    text = path.read_text(encoding="utf-8", errors="replace")
    return f"# {path.name}\n\n```{lang}\n{text}\n```\n"


def read_text_document(path: Path) -> str:
    """Read a plain-text *document*-kind source as UTF-8. Zero dependencies.

    Markdown-family extensions (``.md``/``.markdown``) are already valid
    Markdown, so they are returned verbatim (raw passthrough). Other
    plain-text formats (``.txt``/``.text``/``.rst``/``.org``/``.tex``/
    ``.log``) are lightly wrapped in a fenced code block, mirroring
    :func:`read_artifact_as_markdown`'s presentation for consistency.
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() in _MARKDOWN_PASSTHROUGH_EXTENSIONS:
        return text
    lang = _ARTIFACT_LANG_HINTS.get(path.suffix.lower(), "")
    return f"# {path.name}\n\n```{lang}\n{text}\n```\n"
