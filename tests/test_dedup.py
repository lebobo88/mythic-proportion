"""Tests for ingest/dedup.py — content hashing and the provenance ledger."""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.ingest.dedup import Ledger, content_hash


def test_content_hash_is_stable_for_same_bytes(tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    f.write_text("hello world", encoding="utf-8")
    h1 = content_hash(f)
    h2 = content_hash(f)
    assert h1 == h2
    assert len(h1) == 64  # sha256 hex digest length


def test_content_hash_differs_for_different_bytes(tmp_path: Path) -> None:
    f1 = tmp_path / "a.txt"
    f2 = tmp_path / "b.txt"
    f1.write_text("hello", encoding="utf-8")
    f2.write_text("world", encoding="utf-8")
    assert content_hash(f1) != content_hash(f2)


def test_content_hash_accepts_raw_bytes(tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    data = b"raw byte content"
    f.write_bytes(data)
    assert content_hash(f) == content_hash(data)


def test_ledger_persists_across_instances(tmp_path: Path) -> None:
    ledger_path = tmp_path / "ingested.json"
    ledger = Ledger(ledger_path)
    assert not ledger.already_ingested("deadbeef")

    ledger.record(
        "deadbeef",
        original_name="a.txt",
        raw_path=tmp_path / "raw" / "deadbeef.txt",
        kind="artifact",
    )
    assert ledger.already_ingested("deadbeef")
    assert ledger_path.is_file()

    reloaded = Ledger(ledger_path)
    assert reloaded.already_ingested("deadbeef")
    assert len(reloaded) == 1
    entry = reloaded.get("deadbeef")
    assert entry is not None
    assert entry["original_name"] == "a.txt"
    assert entry["kind"] == "artifact"


def test_ledger_already_ingested_false_for_unknown_hash(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ingested.json")
    assert not ledger.already_ingested("nonexistent")
