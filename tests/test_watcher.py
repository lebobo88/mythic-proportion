"""Tests for the Phase 6 watcher: pure debounce logic + the triggered ingest cycle.

No `watchdog` install and no real sleeps anywhere in this file — the clock is
injected into `DropDebouncer`, and `run_watch(once=True)` exercises the
triggered ingest cycle without starting a filesystem observer at all.
"""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.vault.init import init_vault
from mythic_proportion.watch.watcher import DropDebouncer, run_watch


class _FakeClock:
    """A manually-advanceable stand-in for time.monotonic."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


# --------------------------------------------------------------------------
# DropDebouncer -- pure logic, injected clock, no real sleeps
# --------------------------------------------------------------------------


def test_single_notify_is_not_ready_until_settle_elapses() -> None:
    clock = _FakeClock()
    debouncer = DropDebouncer(settle=1.5, clock=clock)

    debouncer.notify()
    assert debouncer.ready() == []  # no time has passed yet

    clock.advance(1.0)
    assert debouncer.ready() == []  # still within the settle window

    clock.advance(0.6)  # total elapsed since notify() = 1.6s > 1.5s settle
    assert debouncer.ready() == ["__drop__"]


def test_burst_of_notifies_coalesces_into_exactly_one_ready_result() -> None:
    """A file still being written (several rapid events) must settle into
    exactly one ready() result -- proving no double-fire on a burst."""
    clock = _FakeClock()
    debouncer = DropDebouncer(settle=1.5, clock=clock)

    # Simulate a burst: several events in quick succession, each resetting
    # the settle countdown.
    for _ in range(5):
        debouncer.notify()
        clock.advance(0.3)  # well within the settle window each time
        assert debouncer.ready() == []

    # Now let the settle window fully elapse with no further activity.
    clock.advance(1.5)
    ready = debouncer.ready()
    assert ready == ["__drop__"]

    # Ready is popped -- calling again immediately yields nothing more.
    assert debouncer.ready() == []


def test_ready_is_returned_exactly_once_per_settle_window() -> None:
    clock = _FakeClock()
    debouncer = DropDebouncer(settle=1.0, clock=clock)

    debouncer.notify()
    clock.advance(2.0)
    assert debouncer.ready() == ["__drop__"]
    assert debouncer.ready() == []  # not returned twice

    # A fresh notify() re-arms the countdown for a second, independent cycle.
    debouncer.notify()
    clock.advance(2.0)
    assert debouncer.ready() == ["__drop__"]


def test_has_pending_reflects_unsettled_state() -> None:
    clock = _FakeClock()
    debouncer = DropDebouncer(settle=1.0, clock=clock)
    assert debouncer.has_pending() is False

    debouncer.notify()
    assert debouncer.has_pending() is True

    clock.advance(1.5)
    debouncer.ready()
    assert debouncer.has_pending() is False


# --------------------------------------------------------------------------
# run_watch(once=True) -- the triggered ingest cycle, no filesystem observer
# --------------------------------------------------------------------------


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


def test_run_watch_once_ingests_a_single_dropped_file_exactly_once(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    (vault / "drop" / "note.json").write_text('{"hello": "watcher"}', encoding="utf-8")

    run_watch(vault, once=True, compile=False)

    assert list((vault / "drop").iterdir()) == []
    raw_files = list((vault / "raw").iterdir())
    assert len(raw_files) == 1


def test_run_watch_once_is_a_no_op_on_an_already_ingested_drop(tmp_path: Path) -> None:
    """Calling run_watch(once=True) twice on the same content must never
    double-ingest -- the ledger + drop-emptying already established in
    Phase 2 is exactly what prevents the second fire."""
    vault = _seed_vault(tmp_path)
    (vault / "drop" / "note.json").write_text('{"hello": "watcher"}', encoding="utf-8")

    run_watch(vault, once=True, compile=False)
    raw_files_first = list((vault / "raw").iterdir())
    assert len(raw_files_first) == 1

    # Nothing left in drop/, so a second cycle is a true no-op.
    run_watch(vault, once=True, compile=False)
    raw_files_second = list((vault / "raw").iterdir())
    assert raw_files_second == raw_files_first


def test_run_watch_once_reports_activity_via_callback(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    (vault / "drop" / "note.json").write_text("{}", encoding="utf-8")

    messages: list[str] = []
    run_watch(vault, once=True, compile=False, on_activity=messages.append)

    assert any("ingested 1" in m for m in messages)


def test_run_watch_once_with_compile_and_no_provider_reports_activity_without_crashing(
    tmp_path: Path, monkeypatch
) -> None:
    """compile=True in run_watch always resolves its own client via
    load_settings/_default_client (same as `mythic ingest --compile`). As of
    the AuthHub migration, with no AUTHHUB_API_KEY/ANTHROPIC_API_KEY
    configured, that per-source compile call raises CompileError -- which
    `_run_ingest_cycle` must catch and log (via `on_activity`), not let take
    down the watch cycle. No page is written."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    vault = _seed_vault(tmp_path)
    (vault / "drop" / "note.json").write_text('{"hello": "world"}', encoding="utf-8")

    activity: list[str] = []
    run_watch(vault, once=True, compile=True, on_activity=activity.append)

    assert any("compile failed" in line and "AUTHHUB_API_KEY" in line for line in activity)
    assert any(line.startswith("compiled 0/1") for line in activity)

    stub_pages = list((vault / "wiki" / "sources").glob("*.md"))
    assert len(stub_pages) == 0


def test_watch_dependency_error_message_is_actionable(monkeypatch) -> None:
    """``watchdog`` is lazy-imported inside ``_build_watchdog_observer`` --
    simulate it being absent (via a blocked ``import``) rather than relying
    on the *actual* dev/CI environment not having the optional ``watch``
    extra installed, which isn't a safe assumption to make about every
    machine this suite runs on."""
    import builtins

    from mythic_proportion.watch.watcher import WatchDependencyError, _build_watchdog_observer
    from mythic_proportion.watch.watcher import DropDebouncer as _DD

    real_import = builtins.__import__

    def _blocked_import(name, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if name == "watchdog" or name.startswith("watchdog."):
            raise ImportError("no module named watchdog")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocked_import)

    try:
        _build_watchdog_observer(Path("."), _DD())
    except WatchDependencyError as exc:
        assert "pip install" in str(exc)
        assert "watch" in str(exc)
    else:
        raise AssertionError("expected WatchDependencyError when watchdog is not installed")


# --------------------------------------------------------------------------
# CLI wiring
# --------------------------------------------------------------------------


def test_cli_watch_help() -> None:
    from typer.testing import CliRunner

    from mythic_proportion.cli.app import app

    runner = CliRunner()
    result = runner.invoke(app, ["watch", "--help"])
    assert result.exit_code == 0, result.output
    assert "--settle" in result.output
    assert "--compile" in result.output
