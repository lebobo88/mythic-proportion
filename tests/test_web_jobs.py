"""Tests for the single-worker background ingest queue (``web.jobs``).

Exercises :class:`~mythic_proportion.web.jobs.IngestWorker` directly (no
FastAPI needed) so these are collected/run unconditionally, unlike
``test_web.py`` which is guarded by ``pytest.importorskip("fastapi")``.
No live network is used anywhere in this file.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from mythic_proportion.compile.models import CompileError, CompileResult, WikiPage
from mythic_proportion.compile.writer import write_page
from mythic_proportion.config import Settings
from mythic_proportion.vault.init import init_vault
from mythic_proportion.web import jobs as web_jobs_module
from mythic_proportion.web.jobs import IngestWorker


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


def _settings(vault: Path) -> Settings:
    return Settings(vault_path=vault)


def _drop_file(vault: Path, name: str, content: bytes = b"# note\n\nSome content.\n") -> None:
    drop_dir = vault / "drop"
    drop_dir.mkdir(parents=True, exist_ok=True)
    (drop_dir / name).write_bytes(content)


@pytest.fixture
def worker(tmp_path: Path):
    vault = _seed_vault(tmp_path)
    w = IngestWorker(vault, get_settings=lambda: _settings(vault))
    w.start()
    yield w, vault
    w.stop(timeout=5.0)


def test_ingest_status_shape_for_a_completed_job(worker, monkeypatch) -> None:
    w, vault = worker

    def _fake_compile_source(vault_root, source, *, settings=None, client=None, now=None):  # noqa: ANN001
        page = WikiPage.new(page_type="source", title=f"Compiled {source.original_name}", body="stand-in body")
        write_page(vault_root, page)
        return CompileResult(pages=[page], contradictions=[], links_created=[])

    monkeypatch.setattr(web_jobs_module, "compile_source", _fake_compile_source)

    _drop_file(vault, "alpha.md")
    job_id = w.enqueue()
    assert w.wait_idle(timeout=5.0)

    job = w.get_job(job_id)
    assert job is not None
    assert job["id"] == job_id
    assert job["status"] == "done"
    assert job["done"] is True
    assert job["ingested"] == 1
    assert job["compiled"] == 1
    assert job["skipped"] == 0
    assert job["errors"] == []
    assert job["ingested_files"] == ["alpha.md"]
    assert isinstance(job["files"], list) and len(job["files"]) == 1
    file_entry = job["files"][0]
    assert file_entry["name"] == "alpha.md"
    assert file_entry["status"] == "done"
    for key in ("id", "status", "done", "files", "created_at", "updated_at", "ingested", "compiled", "skipped", "errors"):
        assert key in job


def test_get_job_with_no_id_returns_most_recent(worker) -> None:
    w, _vault = worker

    job_id_1 = w.enqueue()
    assert w.wait_idle(timeout=5.0)
    job_id_2 = w.enqueue()
    assert w.wait_idle(timeout=5.0)

    latest = w.get_job()
    assert latest is not None
    assert latest["id"] == job_id_2
    assert job_id_1 != job_id_2


def test_get_job_unknown_id_returns_none(worker) -> None:
    w, _vault = worker
    assert w.get_job("does-not-exist") is None


def test_get_job_with_no_jobs_ever_enqueued_returns_none(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    w = IngestWorker(vault, get_settings=lambda: _settings(vault))
    w.start()
    try:
        assert w.get_job() is None
    finally:
        w.stop(timeout=5.0)


def test_sequential_processing_two_jobs_never_overlap(worker, monkeypatch) -> None:
    """Two jobs enqueued back-to-back must never run concurrently -- the
    single worker thread structurally guarantees this, but we prove it here
    by having a patched `ingest_drop` record wall-clock start/end times and
    asserting no overlap."""
    w, vault = worker
    intervals: list[tuple[float, float]] = []
    real_ingest_drop = web_jobs_module.ingest_drop

    def _slow_ingest_drop(vault_root):  # noqa: ANN001
        start = time.monotonic()
        time.sleep(0.15)
        report = real_ingest_drop(vault_root)
        intervals.append((start, time.monotonic()))
        return report

    monkeypatch.setattr(web_jobs_module, "ingest_drop", _slow_ingest_drop)

    job_id_1 = w.enqueue()
    job_id_2 = w.enqueue()
    assert w.wait_idle(timeout=5.0)

    assert len(intervals) == 2
    (start1, end1), (start2, end2) = intervals
    # No overlap in either order.
    assert end1 <= start2 or end2 <= start1

    job1 = w.get_job(job_id_1)
    job2 = w.get_job(job_id_2)
    assert job1["status"] == "done"
    assert job2["status"] == "done"


def test_per_file_compile_error_is_isolated_others_still_succeed(worker, monkeypatch) -> None:
    """One source's compile failing must not abort the job or block later
    sources in the same job -- the job still completes, the failed file is
    marked `error`, and the others are `done`."""
    w, vault = worker

    def _flaky_compile_source(vault_root, source, *, settings=None, client=None, now=None):  # noqa: ANN001
        if source.original_name == "bad.md":
            raise CompileError("simulated provider failure")
        page = WikiPage.new(page_type="source", title=f"Compiled {source.original_name}", body="stand-in body")
        write_page(vault_root, page)
        return CompileResult(pages=[page], contradictions=[], links_created=[])

    monkeypatch.setattr(web_jobs_module, "compile_source", _flaky_compile_source)

    _drop_file(vault, "good-1.md", b"# good one\n\nfirst\n")
    _drop_file(vault, "bad.md", b"# bad one\n\nsecond\n")
    _drop_file(vault, "good-2.md", b"# good two\n\nthird\n")

    job_id = w.enqueue()
    assert w.wait_idle(timeout=5.0)

    job = w.get_job(job_id)
    assert job["status"] == "done"
    assert job["ingested"] == 3
    assert job["compiled"] == 2
    assert len(job["errors"]) == 1
    assert job["errors"][0]["original_name"] == "bad.md"

    statuses = {f["name"]: f["status"] for f in job["files"]}
    assert statuses["good-1.md"] == "done"
    assert statuses["good-2.md"] == "done"
    assert statuses["bad.md"] == "error"


def test_ledger_race_fixed_batch_of_sources_all_recorded(worker, monkeypatch) -> None:
    """Regression for the original defect: dropping several sources at once
    used to lose entries from `compiled.json` under concurrent compiles.
    With the real (un-mocked) `compile_source` -- fed a fake LLM client via
    `_default_client` so no network is used -- running on the single
    serialized worker, every ingested source's content hash must land in
    `compiled.json`; none are lost."""
    from mythic_proportion.compile import pipeline as compile_pipeline
    from mythic_proportion.compile.client import FakeCompileClient

    w, vault = worker

    def _fake_default_client(settings):  # noqa: ANN001
        return FakeCompileClient(
            CompileResult(
                pages=[WikiPage.new(page_type="source", title="Stand-in Page", body="stand-in body")],
                contradictions=[],
            )
        )

    monkeypatch.setattr(compile_pipeline, "_default_client", _fake_default_client)

    names = [f"source-{i}.md" for i in range(6)]
    for i, name in enumerate(names):
        _drop_file(vault, name, f"# doc {i}\n\nunique content {i}\n".encode())

    job_id = w.enqueue()
    assert w.wait_idle(timeout=5.0)

    job = w.get_job(job_id)
    assert job["status"] == "done"
    assert job["ingested"] == len(names)
    assert job["compiled"] == len(names)
    assert job["errors"] == []

    ledger = compile_pipeline.CompiledLedger(vault / compile_pipeline.COMPILED_LEDGER_RELATIVE_PATH)
    ingest_ledger_path = vault / ".vault-meta" / "ingested.json"
    from mythic_proportion.ingest.dedup import Ledger

    ingest_ledger = Ledger(ingest_ledger_path)
    recorded_hashes = [h for h, _entry in ingest_ledger.items()]
    assert len(recorded_hashes) == len(names)
    for content_hash_value in recorded_hashes:
        assert ledger.already_compiled(content_hash_value), (
            f"{content_hash_value} missing from compiled.json -- ledger race regression"
        )


def test_worker_stop_is_idempotent_and_bounded(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    w = IngestWorker(vault, get_settings=lambda: _settings(vault))
    w.start()
    w.stop(timeout=5.0)
    # Calling stop() again (or on a worker that was never started) must not
    # hang or raise.
    w.stop(timeout=5.0)

    never_started = IngestWorker(vault, get_settings=lambda: _settings(vault))
    never_started.stop(timeout=1.0)
