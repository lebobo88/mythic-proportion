"""Orchestrate the compile step end-to-end (Phase 3; LLM-required as of the
AuthHub migration).

``compile_source`` is the single entry point every caller (CLI, watcher,
tests) should use: given one :class:`IngestedSource`, it picks the configured
LLM client, builds the prompt, compiles, writes pages, resolves the wikilink
graph (dangling-link stubs + ``index.md``), refreshes ``hot.md``, and logs
the run to ``wiki/log.md``. A working LLM is required: if no provider is
configured, or the configured provider's call fails, ``compile_source``
raises :class:`~mythic_proportion.compile.models.CompileError` rather than
degrading to a stub page (that graceful-degradation path has been removed).

``compile_pending`` re-derives compilable sources from disk (the ingest
ledger + staged Markdown) for anything ingested but not yet compiled, e.g. in
a separate process/run.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mythic_proportion.compile.client import AnthropicCompileClient, CompileClient
from mythic_proportion.compile.graph import existing_page_titles, refresh_hot, resolve_graph
from mythic_proportion.compile.models import CompileError, CompileResult
from mythic_proportion.compile.prompt import build_compile_prompt
from mythic_proportion.compile.writer import write_page
from mythic_proportion.config import Settings, authhub_api_key, authhub_base_url, load_settings
from mythic_proportion.ingest.dedup import Ledger
from mythic_proportion.ingest.models import IngestedSource
from mythic_proportion.ingest.pipeline import LEDGER_RELATIVE_PATH, STAGING_RELATIVE_DIR
from mythic_proportion.ingest.router import guess_mime
from mythic_proportion.vault.layout import SCHEMA_FILE

COMPILED_LEDGER_RELATIVE_PATH = Path(".vault-meta") / "compiled.json"
COMPILE_LOG_RELATIVE_PATH = Path("wiki") / "log.md"


#: Bounds the retry loop in :func:`_atomic_write_json` for the transient
#: Windows "sharing violation" `os.replace` can raise when two threads race
#: to replace the exact same destination path at (near-)the same instant.
_REPLACE_MAX_ATTEMPTS = 10
_REPLACE_RETRY_DELAY_S = 0.01


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Write ``data`` to ``path`` as JSON via a write-to-temp-then-replace.

    ``os.replace`` is atomic on both POSIX and Windows, so a reader never
    observes a half-written file. Mirrors ``ingest.dedup._atomic_write_json``,
    including the bounded retry for Windows' transient sharing-violation
    ``PermissionError`` on ``os.replace``.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True, default=str)

    for attempt in range(_REPLACE_MAX_ATTEMPTS):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == _REPLACE_MAX_ATTEMPTS - 1:
                raise
            time.sleep(_REPLACE_RETRY_DELAY_S)


#: One `threading.Lock` per resolved ledger path, mirroring
#: ``ingest.dedup._ledger_locks`` -- closes the lost-update race for any
#: writers within this process (re-reading-before-write alone narrows but
#: does not close the race window under genuine concurrency). The web
#: ingest path additionally serializes writers structurally via
#: ``web.jobs.IngestWorker``'s single worker thread, so this lock is
#: defense-in-depth, not the only thing standing between a concurrent write
#: and a lost entry.
_compiled_ledger_locks: dict[str, threading.Lock] = {}
_compiled_ledger_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    key = str(Path(path).resolve())
    with _compiled_ledger_locks_guard:
        lock = _compiled_ledger_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _compiled_ledger_locks[key] = lock
        return lock


class CompiledLedger:
    """Persisted content-hash -> compiled-at record, mirroring ``ingest.dedup.Ledger``.

    Tracks which already-ingested sources have already been compiled, so
    ``compile_pending`` can resume across process restarts without recompiling
    (and duplicating) pages for the same source.

    Historically each :func:`compile_source` call constructed a fresh
    ``CompiledLedger``, read the file, added exactly one entry, and wrote it
    straight back -- when several ``compile_source`` calls ran concurrently
    (e.g. the pre-worker web ``/api/upload`` path processing several dropped
    files at once) this was a classic lost-update race: two writers could
    each read the same on-disk snapshot and each write back a version missing
    the other's entry. :meth:`record` now re-reads the file immediately
    before merging its own entry in, and :meth:`save` writes atomically
    (write-to-temp-then-``os.replace``), which bounds that window even for a
    second concurrent writer (e.g. a separate CLI process). In the web path
    this race is now also structurally eliminated in-process, since
    ``web.jobs.IngestWorker`` serializes every compile through one worker
    thread.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._entries: dict[str, dict[str, Any]] = self._load()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.is_file():
            return {}
        with self.path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}

    def save(self) -> None:
        _atomic_write_json(self.path, self._entries)

    def already_compiled(self, content_hash_value: str) -> bool:
        return content_hash_value in self._entries

    def record(self, content_hash_value: str, *, compiled_at: datetime) -> None:
        # Serialize the whole read-merge-write against any other writer (in
        # this process) targeting the same path, then re-read from disk so
        # a writer from *outside* this process isn't clobbered either (see
        # class docstring).
        with _lock_for(self.path):
            self._entries = {**self._load(), **self._entries}
            self._entries[content_hash_value] = {"compiled_at": compiled_at.isoformat()}
            self.save()


def _default_client(settings: Settings) -> CompileClient:
    """Build the client for ``settings.llm_provider``.

    Raises :class:`CompileError` with an actionable message if the required
    credential is missing -- a working LLM is required for compile as of the
    AuthHub migration; there is no longer a "return None -> degrade" path.
    """
    if settings.llm_provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise CompileError(
                "LLM not configured: set ANTHROPIC_API_KEY (provider=anthropic, "
                f"model={settings.model!r})"
            )
        return AnthropicCompileClient(model=settings.model, api_key=api_key)

    if settings.llm_provider == "authhub":
        api_key = authhub_api_key()
        base_url = authhub_base_url(settings)
        if not api_key:
            raise CompileError(
                f"LLM not configured: set AUTHHUB_API_KEY (provider=authhub, base_url={base_url!r})"
            )
        from mythic_proportion.llm.authhub import AuthHubCompileClient

        return AuthHubCompileClient(
            base_url=base_url,
            api_key=api_key,
            model=settings.llm_model,
            route_alias=settings.route_alias or None,
        )

    raise CompileError(f"LLM not configured: unknown llm_provider {settings.llm_provider!r}")


def _append_log(vault_root: Path, lines: list[str]) -> None:
    log_path = vault_root / COMPILE_LOG_RELATIVE_PATH
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not log_path.exists():
        log_path.write_text("# Ingestion log\n\n", encoding="utf-8")
    with log_path.open("a", encoding="utf-8") as f:
        for line in lines:
            f.write(line + "\n")


def compile_source(
    vault_root: Path,
    source: IngestedSource,
    *,
    client: CompileClient | None = None,
    settings: Settings | None = None,
    now: datetime | None = None,
) -> CompileResult:
    """Compile one ingested source into wiki pages and weave it into the graph.

    ``client`` overrides automatic client selection (used by tests to inject
    a :class:`~mythic_proportion.compile.client.FakeCompileClient`). If
    ``client`` is ``None``, the client configured by ``settings.llm_provider``
    is used. A working LLM is required: if no provider is configured, or the
    client's ``compile`` call raises, this raises
    :class:`~mythic_proportion.compile.models.CompileError` -- it no longer
    degrades to a stub page.
    """
    vault_root = Path(vault_root)
    settings = settings or load_settings(vault_root)
    now = now or datetime.now(timezone.utc)
    active_client = client if client is not None else _default_client(settings)

    schema_path = vault_root / SCHEMA_FILE
    schema_md = schema_path.read_text(encoding="utf-8") if schema_path.is_file() else ""
    titles = existing_page_titles(vault_root)
    prompt = build_compile_prompt(schema_md=schema_md, existing_titles=titles, source=source)
    result = active_client.compile(prompt)

    written_titles: list[str] = []
    for page in result.pages:
        fm = dict(page.frontmatter)
        fm.setdefault("source_hash", source.content_hash)
        page_with_source = page.model_copy(update={"frontmatter": fm})
        write_page(vault_root, page_with_source, now=now)
        written_titles.append(page.title)

    graph_result = resolve_graph(vault_root, now=now)
    refresh_hot(vault_root, recent_titles=written_titles)

    _append_log(
        vault_root,
        [
            f"- {now.isoformat()} COMPILED {source.original_name} ({source.content_hash[:12]}) "
            f"-> {len(result.pages)} page(s), {len(result.contradictions)} contradiction(s), "
            f"{len(graph_result.stub_titles)} stub(s) created",
        ],
    )

    CompiledLedger(vault_root / COMPILED_LEDGER_RELATIVE_PATH).record(source.content_hash, compiled_at=now)

    return CompileResult(
        pages=result.pages,
        contradictions=result.contradictions,
        links_created=list(graph_result.stub_titles),
    )


def compile_pending(
    vault_root: Path,
    *,
    client: CompileClient | None = None,
    settings: Settings | None = None,
) -> list[CompileResult]:
    """Compile every ingested-but-not-yet-compiled source found on disk.

    Reconstructs a minimal :class:`IngestedSource` from the ingest ledger and
    its staged parsed Markdown — useful when compile is triggered in a
    separate process/run from the original ``ingest_drop`` call.
    """
    vault_root = Path(vault_root)
    ingest_ledger = Ledger(vault_root / LEDGER_RELATIVE_PATH)
    compiled_ledger = CompiledLedger(vault_root / COMPILED_LEDGER_RELATIVE_PATH)

    results: list[CompileResult] = []
    for content_hash_value, entry in ingest_ledger.items():
        if compiled_ledger.already_compiled(content_hash_value):
            continue

        staging_path = vault_root / STAGING_RELATIVE_DIR / f"{content_hash_value}.md"
        if not staging_path.is_file():
            continue

        raw_path = Path(entry["raw_path"])
        if not raw_path.is_absolute():
            raw_path = vault_root / raw_path
        size = raw_path.stat().st_size if raw_path.is_file() else 0

        source = IngestedSource(
            original_name=entry["original_name"],
            content_hash=content_hash_value,
            raw_path=raw_path,
            kind=entry["kind"],
            parsed_markdown=staging_path.read_text(encoding="utf-8"),
            mime=guess_mime(raw_path),
            bytes=size,
            ingested_at=datetime.fromisoformat(entry["ingested_at"]),
        )
        results.append(compile_source(vault_root, source, client=client, settings=settings))

    return results
