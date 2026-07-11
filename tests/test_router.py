"""Tests for ingest/router.py classification (Phase 2)."""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.ingest.router import classify


def test_classify_documents() -> None:
    for ext in (
        ".pdf",
        ".docx",
        ".pptx",
        ".xlsx",
        ".html",
        ".htm",
        ".md",
        ".txt",
        ".rtf",
        ".odt",
    ):
        assert classify(Path(f"file{ext}")) == "document", ext


def test_classify_images() -> None:
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".tiff", ".gif", ".bmp"):
        assert classify(Path(f"file{ext}")) == "image", ext


def test_classify_artifacts() -> None:
    for ext in (
        ".py",
        ".js",
        ".ts",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".csv",
        ".log",
        ".sh",
        ".sql",
    ):
        assert classify(Path(f"file{ext}")) == "artifact", ext


def test_classify_unknown_extension_falls_back_to_artifact() -> None:
    assert classify(Path("file.mystery")) == "artifact"
    assert classify(Path("no_extension_at_all")) == "artifact"


def test_classify_is_case_insensitive() -> None:
    assert classify(Path("FILE.PDF")) == "document"
    assert classify(Path("FILE.PNG")) == "image"
