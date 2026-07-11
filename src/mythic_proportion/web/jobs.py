"""A single-worker background ingest queue for the web UI.

Dropping several large documents used to fire one synchronous
``ingest_drop`` + ``compile_source`` (multiple blocking LLM HTTP calls) +
full ``IndexStore.reindex`` *per concurrent request* -- a CPU stampede that
starved read endpoints, plus an unguarded read-modify-write race on shared
state files (``CompiledLedger``, ``resolve_graph``/``refresh_hot``) when two
uploads landed at the same time.

:class:`IngestWorker` fixes both by construction: exactly one background
thread ever calls ``ingest_drop``/``compile_source``/``IndexStore.reindex``,
fed by a FIFO ``queue.Queue`` of job ids. ``POST /api/upload`` and
``POST /api/ingest`` (see ``web.app``) just enqueue a job and return its id
immediately; this module owns pulling jobs off the queue, running them
end-to-end, and publishing live per-file progress that
``GET /api/ingest/status`` polls.

Every job re-reads ``get_settings()`` (typically ``lambda: app.state.settings``)
at run time, not at enqueue time, so a model/provider change via
``POST /api/config`` mid-session applies to whatever job runs next.
"""

from __future__ import annotations

import itertools
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.config import Settings
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.ingest.pipeline import ingest_drop

JobStatus = Literal["queued", "running", "done"]
FileStatus = Literal["queued", "compiling", "done", "error"]


@dataclass
class JobFileStatus:
    """Per-file progress within one :class:`IngestJob`."""

    name: str
    status: FileStatus = "queued"
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "status": self.status, "message": self.message}


@dataclass
class IngestJob:
    """One enqueued ``ingest_drop`` (+ per-source ``compile_source`` + one
    end-of-job ``IndexStore.reindex``) run, with live progress."""

    id: str
    status: JobStatus = "queued"
    files: list[JobFileStatus] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    ingested: int = 0
    ingested_files: list[str] = field(default_factory=list)
    skipped: int = 0
    compiled: int = 0
    errors: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "done": self.status == "done",
            "files": [f.to_dict() for f in self.files],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "ingested": self.ingested,
            "ingested_files": list(self.ingested_files),
            "skipped": self.skipped,
            "compiled": self.compiled,
            "errors": list(self.errors),
        }


#: What ``GET /api/ingest/status`` returns when no job has ever been
#: enqueued -- deliberately shaped identically to ``IngestJob.to_dict()`` so
#: the frontend never needs a special-case branch.
_IDLE_STATE: dict[str, Any] = {
    "id": None,
    "status": "idle",
    "done": True,
    "files": [],
    "created_at": None,
    "updated_at": None,
    "ingested": 0,
    "ingested_files": [],
    "skipped": 0,
    "compiled": 0,
    "errors": [],
}


class IngestWorker:
    """Owns one FIFO queue of ingest jobs and the single daemon thread that
    drains it.

    Because there is exactly one worker thread, every ``compile_source`` /
    ``IndexStore.reindex`` / ledger / graph write it triggers happens
    strictly sequentially -- no CPU stampede, no write race -- without any
    additional locking of *those* code paths. Job bookkeeping itself (the
    ``IngestJob`` objects other threads poll via :meth:`get_job`) is guarded
    by ``self._lock`` since the FastAPI request threads read it concurrently
    with the worker thread mutating it.
    """

    def __init__(self, vault_root: Path, *, get_settings: Any) -> None:
        self._vault_root = Path(vault_root)
        self._get_settings = get_settings
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._lock = threading.Lock()
        self._jobs: dict[str, IngestJob] = {}
        self._job_order: list[str] = []
        self._id_counter = itertools.count(1)
        self._idle_event = threading.Event()
        self._idle_event.set()
        self._thread = threading.Thread(
            target=self._run, name="mythic-ingest-worker", daemon=True
        )
        self._started = False

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if not self._started:
            self._started = True
            self._thread.start()

    def stop(self, *, timeout: float | None = 5.0) -> None:
        """Ask the worker thread to exit and wait (bounded) for it to do so.

        Safe to call even if :meth:`start` was never called or the thread
        already exited.
        """
        if not self._started:
            return
        self._queue.put(None)
        self._thread.join(timeout=timeout)

    # -- producer side (FastAPI request threads) ---------------------------

    def enqueue(self) -> str:
        """Queue a new ingest job for whatever is currently in ``drop/`` and
        return its id immediately."""
        job_id = f"job-{next(self._id_counter)}"
        job = IngestJob(id=job_id)
        with self._lock:
            self._jobs[job_id] = job
            self._job_order.append(job_id)
        self._idle_event.clear()
        self._queue.put(job_id)
        return job_id

    def get_job(self, job_id: str | None = None) -> dict[str, Any] | None:
        """Return the job's current state as a plain dict, or ``None`` if
        ``job_id`` doesn't exist. With ``job_id=None``, returns the most
        recently enqueued job (or ``None`` if none has ever been enqueued)."""
        with self._lock:
            resolved_id = job_id if job_id is not None else (self._job_order[-1] if self._job_order else None)
            if resolved_id is None:
                return None
            job = self._jobs.get(resolved_id)
            return job.to_dict() if job is not None else None

    def wait_idle(self, timeout: float | None = 5.0) -> bool:
        """Block (bounded by ``timeout``) until the queue has fully drained.

        Deterministic test hook -- tests enqueue a job then
        ``worker.wait_idle(timeout=...)`` instead of sleeping/polling.
        Returns ``True`` if the worker went idle within the timeout.
        """
        return self._idle_event.wait(timeout=timeout)

    # -- consumer side (the single worker thread) --------------------------

    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                if job_id is None:
                    return
                self._process_job(job_id)
            finally:
                self._queue.task_done()
                if self._queue.empty():
                    self._idle_event.set()

    def _set_file_status(self, job: IngestJob, name: str, status: FileStatus, message: str | None = None) -> None:
        for entry in job.files:
            if entry.name == name:
                entry.status = status
                entry.message = message
                return

    def _process_job(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = "running"
            job.updated_at = time.time()

        try:
            self._run_job(job)
        except Exception as exc:  # noqa: BLE001 - a job failure must never kill the worker thread
            with self._lock:
                job.errors.append({"original_name": "<job>", "message": f"unexpected worker error: {exc}"})
        finally:
            with self._lock:
                job.status = "done"
                job.updated_at = time.time()

    def _run_job(self, job: IngestJob) -> None:
        vault_root = self._vault_root
        settings: Settings = self._get_settings()

        report = ingest_drop(vault_root)

        with self._lock:
            job.ingested = len(report.ingested)
            job.ingested_files = [s.original_name for s in report.ingested]
            job.skipped = len(report.skipped)
            job.errors = [{"original_name": e.original_name, "message": e.message} for e in report.errors]
            job.files = [JobFileStatus(name=s.original_name, status="queued") for s in report.ingested]
            job.files.extend(
                JobFileStatus(name=e.original_name, status="error", message=e.message) for e in report.errors
            )
            job.files.extend(
                JobFileStatus(name=s.original_name, status="done", message="duplicate (skipped)")
                for s in report.skipped
            )
            job.updated_at = time.time()

        for source in report.ingested:
            with self._lock:
                self._set_file_status(job, source.original_name, "compiling")
                job.updated_at = time.time()
            try:
                compile_source(vault_root, source, settings=settings)
                with self._lock:
                    job.compiled += 1
                    self._set_file_status(job, source.original_name, "done")
            except CompileError as exc:
                with self._lock:
                    job.errors.append({"original_name": source.original_name, "message": str(exc)})
                    self._set_file_status(job, source.original_name, "error", str(exc))
            with self._lock:
                job.updated_at = time.time()

        # One reindex per job, not per source. IndexStore.reindex is already
        # incremental (only pages whose body content hash changed are
        # re-embedded/re-written; see index.store.IndexStore.reindex), so
        # this is cheap even when nothing changed.
        embedder = get_embedder(settings)
        with IndexStore(vault_root, embedder) as store:
            store.reindex(vault_root)
