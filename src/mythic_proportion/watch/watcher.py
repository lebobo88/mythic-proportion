"""Optional real-time watcher over ``vault/drop/`` (Phase 6).

This is a thin real-time transport layer over the *exact same* triggered
pipeline Phases 2/3 already established (``ingest.pipeline.ingest_drop`` +
``compile.pipeline.compile_source``) — there is no separate watch-time code
path to drift from the CLI's own ``mythic ingest`` behavior.

Two concerns are deliberately kept apart so the debounce/dispatch logic is
unit-testable without ``watchdog`` installed and without real sleeps:

* :class:`DropDebouncer` — pure, clock-injectable coalescing logic. Feed it
  synthetic ``notify()`` calls (as a real filesystem watcher, or a test,
  would) and poll :meth:`DropDebouncer.ready` to find out when a settle
  window has elapsed with no further activity.
* The ``watchdog`` ``Observer`` — a thin transport wired up only inside
  :func:`run_watch` (lazy-imported, exactly like the Docling/MarkItDown/
  Anthropic adapters elsewhere in this package), whose only job is to call
  ``DropDebouncer.notify()`` on filesystem events.

A single burst of filesystem events (e.g. a multi-file copy, or a file still
being written) coalesces into exactly one ``notify()``-driven settle window,
which in turn triggers exactly one ingest cycle — never a double-fire.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.compile.writer import _AdvisoryLock  # reuse the same advisory-lock design
from mythic_proportion.config import load_settings
from mythic_proportion.ingest.pipeline import IngestReport, ingest_drop

_INSTALL_HINT = "pip install 'mythic-proportion[watch]'"

#: The single coalescing key used for every filesystem event under drop/.
#: ``ingest_drop`` already processes the *entire* drop directory in one call,
#: so there is no benefit to debouncing per-file — coalescing every event
#: under one key is what turns a multi-file burst into exactly one ingest.
_DROP_KEY = "__drop__"

WATCH_LOCK_RELATIVE_PATH = Path(".vault-meta") / "watch.lock"


class WatchDependencyError(Exception):
    """Raised when ``watchdog`` is not installed but real-time watching was requested."""


class DropDebouncer:
    """Pure, clock-injectable debounce/coalescer.

    Every call to :meth:`notify` (re)starts a ``settle``-second countdown for
    a given key (default: the single shared drop-folder key). :meth:`ready`
    returns — and clears — every key whose countdown has elapsed since its
    most recent ``notify()`` call, so a burst of events collapses into
    exactly one ``ready()`` result per settle window.

    No real sleeping happens here: ``clock`` is an injectable zero-arg
    callable returning the current time (defaults to :func:`time.monotonic`),
    so tests can advance "time" deterministically without waiting.
    """

    def __init__(self, settle: float = 1.5, clock: Callable[[], float] | None = None) -> None:
        if settle <= 0:
            raise ValueError("settle must be a positive number of seconds")
        self._settle = settle
        self._clock = clock or time.monotonic
        self._pending: dict[str, float] = {}

    @property
    def settle(self) -> float:
        return self._settle

    def notify(self, key: str = _DROP_KEY) -> None:
        """Record (or refresh) an event for ``key``, resetting its settle timer."""
        self._pending[key] = self._clock()

    def has_pending(self) -> bool:
        """True if any key is currently mid-countdown (not yet settled)."""
        return bool(self._pending)

    def ready(self) -> list[str]:
        """Return every key whose settle window has elapsed, removing it from pending.

        Each key is returned at most once per settle window: once popped by
        ``ready()``, a key only reappears if :meth:`notify` is called again.
        """
        now = self._clock()
        settled = [key for key, last_seen in self._pending.items() if now - last_seen >= self._settle]
        for key in settled:
            del self._pending[key]
        return settled


def _run_ingest_cycle(
    vault_root: Path,
    *,
    compile: bool,
    on_activity: Callable[[str], None] | None = None,
) -> IngestReport | None:
    """Run exactly one ingest (+ optional compile) cycle, guarded by a vault-level lock.

    Reuses :class:`~mythic_proportion.compile.writer._AdvisoryLock` — the same
    create-exclusive, stale-reaping advisory lock already used per-page by the
    compile writer — at the whole-vault level, so an ingest cycle already in
    flight is never re-entered even if the caller mis-fires twice.
    """
    vault_root = Path(vault_root)
    lock_path = vault_root / WATCH_LOCK_RELATIVE_PATH

    def _log(message: str) -> None:
        if on_activity is not None:
            on_activity(message)

    try:
        with _AdvisoryLock(lock_path):
            report = ingest_drop(vault_root)
            _log(
                f"ingested {len(report.ingested)}, skipped {len(report.skipped)}, "
                f"errors {len(report.errors)}"
            )
            if compile and report.ingested:
                settings = load_settings(vault_root)
                compiled = 0
                for source in report.ingested:
                    try:
                        compile_source(vault_root, source, settings=settings)
                        compiled += 1
                    except CompileError as exc:
                        # A missing/misconfigured LLM provider must not take
                        # down the watcher -- log and keep watching, exactly
                        # like `mythic ingest`'s per-source error handling.
                        _log(f"compile failed for {source.original_name}: {exc}")
                _log(f"compiled {compiled}/{len(report.ingested)} source(s)")
            return report
    except RuntimeError:
        # Another cycle already holds the lock -- skip rather than double-fire.
        _log("skipped: another ingest cycle is already in progress")
        return None


def _build_watchdog_observer(drop_dir: Path, debouncer: DropDebouncer) -> Any:
    """Build (but do not start) a ``watchdog`` Observer that notifies ``debouncer``.

    Lazy-imports ``watchdog`` only when actually called, exactly like the
    Docling/MarkItDown/Anthropic adapters elsewhere in this package — simply
    importing this module never requires ``watchdog`` to be installed.
    """
    try:
        from watchdog.events import FileSystemEvent, FileSystemEventHandler
        from watchdog.observers import Observer
    except ImportError as exc:  # pragma: no cover - exercised only when watchdog absent
        raise WatchDependencyError(_INSTALL_HINT) from exc

    class _Handler(FileSystemEventHandler):
        def on_created(self, event: FileSystemEvent) -> None:
            if not event.is_directory:
                debouncer.notify()

        def on_modified(self, event: FileSystemEvent) -> None:
            if not event.is_directory:
                debouncer.notify()

        def on_moved(self, event: FileSystemEvent) -> None:
            if not event.is_directory:
                debouncer.notify()

    observer = Observer()
    observer.schedule(_Handler(), str(drop_dir), recursive=False)
    return observer


def run_watch(
    vault_root: Path,
    *,
    settle: float = 1.5,
    once: bool = False,
    compile: bool = True,
    poll_interval: float = 0.25,
    on_activity: Callable[[str], None] | None = None,
) -> None:
    """Watch ``<vault_root>/drop/`` in real time and trigger ingestion automatically.

    ``once=True`` skips the watchdog observer entirely and simply runs one
    ingest cycle immediately over whatever is already sitting in ``drop/``
    (useful for cron-style invocation or tests). ``once=False`` (the default)
    starts a ``watchdog`` observer and polls the debounce state every
    ``poll_interval`` seconds, running exactly one ingest cycle per settled
    burst of filesystem activity, until interrupted with Ctrl-C
    (``KeyboardInterrupt``), which triggers a clean shutdown.

    ``compile`` mirrors ``mythic ingest --compile/--no-compile``: whether a
    freshly ingested source is also compiled into wiki pages in the same
    cycle. ``on_activity`` is an optional callback (e.g. the CLI's
    ``console.print``) invoked with a short human-readable status string
    after each cycle; left ``None`` this function stays silent (as tests
    want).
    """
    vault_root = Path(vault_root)
    (vault_root / "drop").mkdir(parents=True, exist_ok=True)

    if once:
        _run_ingest_cycle(vault_root, compile=compile, on_activity=on_activity)
        return

    debouncer = DropDebouncer(settle=settle)
    observer = _build_watchdog_observer(vault_root / "drop", debouncer)
    observer.start()
    try:
        while True:
            if debouncer.ready():
                _run_ingest_cycle(vault_root, compile=compile, on_activity=on_activity)
            time.sleep(min(poll_interval, settle))
    except KeyboardInterrupt:
        if on_activity is not None:
            on_activity("stopping (Ctrl-C received)")
    finally:
        observer.stop()
        observer.join()
