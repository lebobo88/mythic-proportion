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
GraphJobStatus = Literal["queued", "running", "done"]


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


@dataclass
class GraphJob:
    """One enqueued GraphRAG ``index-graph`` (build/sync the entity/
    relationship/claim knowledge graph) run, with a final report -- the
    web UI's equivalent of ``mythic index-graph`` (bugfix DEFECT 1: that
    command previously had no real entry point at all)."""

    id: str
    status: GraphJobStatus = "queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    text_units_added: int = 0
    text_units_updated: int = 0
    text_units_deleted: int = 0
    entities_upserted: int = 0
    entities_deleted: int = 0
    relationships_upserted: int = 0
    claims_upserted: int = 0
    llm_calls: int = 0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "done": self.status == "done",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "text_units_added": self.text_units_added,
            "text_units_updated": self.text_units_updated,
            "text_units_deleted": self.text_units_deleted,
            "entities_upserted": self.entities_upserted,
            "entities_deleted": self.entities_deleted,
            "relationships_upserted": self.relationships_upserted,
            "claims_upserted": self.claims_upserted,
            "llm_calls": self.llm_calls,
            "error": self.error,
        }


#: What ``GET /api/index-graph/status`` returns when no graph job has ever
#: been enqueued -- shaped identically to ``GraphJob.to_dict()``.
_GRAPH_IDLE_STATE: dict[str, Any] = {
    "id": None,
    "status": "idle",
    "done": True,
    "created_at": None,
    "updated_at": None,
    "text_units_added": 0,
    "text_units_updated": 0,
    "text_units_deleted": 0,
    "entities_upserted": 0,
    "entities_deleted": 0,
    "relationships_upserted": 0,
    "claims_upserted": 0,
    "llm_calls": 0,
    "error": None,
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
        # Queue items are `("ingest", job_id)` or `("graph", job_id)` --
        # both kinds share this one FIFO queue and single worker thread, so
        # a `POST /api/index-graph` job and a `POST /api/ingest` job (or two
        # of either) can never run concurrently, same "no CPU stampede, no
        # write race" guarantee this class already provided for ingest jobs
        # alone.
        self._queue: queue.Queue[tuple[str, str] | None] = queue.Queue()
        self._lock = threading.Lock()
        self._jobs: dict[str, IngestJob] = {}
        self._job_order: list[str] = []
        self._graph_jobs: dict[str, GraphJob] = {}
        self._graph_job_order: list[str] = []
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
        self._queue.put(("ingest", job_id))
        return job_id

    def enqueue_graph(self) -> str:
        """Queue a new GraphRAG ``index-graph`` job (build/sync the entity/
        relationship/claim knowledge graph over the vault's current `raw/`
        ingested sources) and return its id immediately -- the web UI's
        "Build Knowledge Graph" action, and the async-job/progress
        counterpart to `mythic index-graph`."""
        job_id = f"graph-job-{next(self._id_counter)}"
        job = GraphJob(id=job_id)
        with self._lock:
            self._graph_jobs[job_id] = job
            self._graph_job_order.append(job_id)
        self._idle_event.clear()
        self._queue.put(("graph", job_id))
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

    def get_graph_job(self, job_id: str | None = None) -> dict[str, Any] | None:
        """Same contract as :meth:`get_job`, for graph jobs."""
        with self._lock:
            resolved_id = (
                job_id if job_id is not None else (self._graph_job_order[-1] if self._graph_job_order else None)
            )
            if resolved_id is None:
                return None
            job = self._graph_jobs.get(resolved_id)
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
            item = self._queue.get()
            try:
                if item is None:
                    return
                kind, job_id = item
                if kind == "graph":
                    self._process_graph_job(job_id)
                else:
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

        # Bugfix DEFECT 1 (wiring gap): the "auto-build knowledge graph
        # after ingest" Settings toggle -- OFF by default (real LLM-cost
        # concern, see `mythic index-graph`'s own docstring). A failure here
        # is recorded as a job error, exactly like a per-source compile
        # failure above, and never aborts/crashes the worker thread.
        if settings.auto_build_graph:
            try:
                self._do_reindex_graph(settings)
            except Exception as exc:  # noqa: BLE001 - never let auto-graph-build kill the worker thread
                with self._lock:
                    job.errors.append({"original_name": "<index-graph>", "message": str(exc)})
                    job.updated_at = time.time()

    def _process_graph_job(self, job_id: str) -> None:
        with self._lock:
            job = self._graph_jobs[job_id]
            job.status = "running"
            job.updated_at = time.time()

        try:
            report = self._do_reindex_graph(self._get_settings())
            with self._lock:
                job.text_units_added = report.text_units_added
                job.text_units_updated = report.text_units_updated
                job.text_units_deleted = report.text_units_deleted
                job.entities_upserted = report.entities_upserted
                job.entities_deleted = report.entities_deleted
                job.relationships_upserted = report.relationships_upserted
                job.claims_upserted = report.claims_upserted
                job.llm_calls = report.llm_calls
        except Exception as exc:  # noqa: BLE001 - a job failure must never kill the worker thread
            with self._lock:
                job.error = str(exc)
        finally:
            with self._lock:
                job.status = "done"
                job.updated_at = time.time()

    def _do_reindex_graph(self, settings: Settings) -> Any:
        """Build the extraction client and run one `reindex_graph` pass --
        shared by the explicit "Build Knowledge Graph" job
        (:meth:`_process_graph_job`) and the auto-build-after-ingest path
        (:meth:`_run_job`). Raises on a setup failure (missing credential,
        redaction unavailable) or an extraction failure -- callers decide
        how to record that (a dedicated `GraphJob.error`, or an ingest
        job's `errors` list)."""
        from mythic_proportion.graph.index import build_extraction_client, reindex_graph

        vault_root = self._vault_root
        embedder = get_embedder(settings)
        client = build_extraction_client(settings)
        with IndexStore(vault_root, embedder) as store:
            store.reindex(vault_root)
            return reindex_graph(
                vault_root,
                store.conn,
                extraction_client=client,
                embedder=embedder,
                vec_active=store.vec_active,
                model=settings.llm_model,
            )
