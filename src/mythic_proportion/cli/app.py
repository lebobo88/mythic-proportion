"""Mythic Proportion CLI — six verbs: init, ingest, query, lint, watch, serve.

Phase 1 wired up the Typer app and the `init` command fully. Phase 2 wires
up `ingest` fully. Phase 3 extends `ingest` with a compile step (LLM-compiled
wiki pages) via `--compile/--no-compile`. Phase 4 adds a hidden utility
command, `reindex`, that syncs the SQLite hybrid-search sidecar so Phase 5's
`query` can rely on a fresh index; it is not one of the five headline verbs,
so it is registered with `hidden=True` and does not appear in `--help`.
Phase 5 wires up `query` (retrieve + LLM-synthesize a cited answer) and
`lint` (vault health check, with `--fix` for auto-repair). As of the AuthHub
migration, both `ingest --compile` and `query` REQUIRE a working, configured
LLM (AuthHub by default, or Anthropic if `MYTHIC_LLM_PROVIDER=anthropic`) --
the earlier no-LLM graceful-degradation fallbacks (stub compile pages,
deterministic ranked-pages answers) have been removed; a missing credential
now surfaces as a clear, actionable error instead of silently degrading.
Phase 6 wires up `watch`
(a real-time, debounced observer over `drop/` that calls the exact same
ingest/compile pipeline as `mythic ingest`) and adds a hidden
`ingest-harness` utility command for pulling a FABLE-HARNESS run's own
`specs/`/`memory/`/`.fable/` artifacts into the vault. Phase 7 adds `serve`,
a sixth headline verb that boots a local web UI (FastAPI/uvicorn, an optional
`[web]` extra) over the exact same building blocks the other five verbs use;
`fastapi`/`uvicorn` are imported lazily inside the command body so this
module -- and the rest of the five-verb CLI -- stays importable without them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.markup import escape

from mythic_proportion.compile.models import CompileError
from mythic_proportion.compile.pipeline import compile_source
from mythic_proportion.config import load_settings
from mythic_proportion.harness_ingest import DEFAULT_FABLE_ARTIFACT_LIMIT, ingest_harness
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.store import IndexStore
from mythic_proportion.ingest.pipeline import ingest_drop
from mythic_proportion.query.client import AnswerError
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.init import init_vault
from mythic_proportion.vault.lint import lint_fix, lint_vault
from mythic_proportion.watch.watcher import WatchDependencyError, run_watch

app = typer.Typer(
    name="mythic",
    help="Mythic Proportion — an LLM-Wiki second brain with an auto-ingesting drop folder.",
    no_args_is_help=True,
)

console = Console()


@app.command()
def init(
    vault_path: Path = typer.Argument(
        ..., help="Directory to initialize (or validate) as a Mythic Proportion vault."
    ),
    force: bool = typer.Option(
        False, "--force", help="Overwrite seed files (schema.md/index.md/hot.md/Obsidian config)."
    ),
) -> None:
    """Create (or validate) the vault skeleton at VAULT_PATH."""
    init_vault(vault_path, force=force)
    console.print(f"[green]Vault initialized at {Path(vault_path).resolve()}[/green]")


@app.command()
def ingest(
    vault_path: Optional[Path] = typer.Argument(
        None, help="Vault to ingest into (defaults to the current directory)."
    ),
    compile_: bool = typer.Option(
        True,
        "--compile/--no-compile",
        help=(
            "Compile newly ingested sources into wiki pages after ingest, using "
            "the configured LLM provider (AuthHub by default; requires "
            "AUTHHUB_API_KEY). A missing/misconfigured provider prints a clean "
            "actionable error for that source rather than a traceback -- ingest "
            "itself still exits 0. Pass --no-compile to skip the compile step "
            "entirely (Phase 2 behavior)."
        ),
    ),
) -> None:
    """Parse, dedup, and file everything currently sitting in vault/drop/."""
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    report = ingest_drop(root)

    console.print(f"[green]Ingested:[/green] {len(report.ingested)}")
    for source in report.ingested:
        console.print(f"  + {source.original_name} -> raw/{source.raw_path.name} ({source.kind})")

    console.print(f"[yellow]Skipped (duplicates):[/yellow] {len(report.skipped)}")
    for skipped in report.skipped:
        console.print(f"  = {skipped.original_name} (already at raw/{skipped.existing_raw_path})")

    console.print(f"[red]Errors:[/red] {len(report.errors)}")
    for error in report.errors:
        console.print(f"  ! {error.original_name}: {error.message}")

    if not compile_ or not report.ingested:
        return

    settings = load_settings(root)
    console.print(f"[cyan]Compiling:[/cyan] {len(report.ingested)}")
    for source in report.ingested:
        try:
            result = compile_source(root, source, settings=settings)
        except CompileError as exc:
            console.print(f"  ! {source.original_name}: {exc}", markup=False)
            continue
        console.print(
            f"  ~ {source.original_name} -> {len(result.pages)} page(s), "
            f"{len(result.contradictions)} contradiction(s), {len(result.links_created)} stub link(s)"
        )


@app.command(hidden=True)
def reindex(
    vault_path: Optional[Path] = typer.Option(
        None, "--vault", help="Vault whose SQLite hybrid-search sidecar to sync (defaults to the current directory)."
    ),
) -> None:
    """Sync the `.index/` SQLite hybrid-search sidecar with `wiki/` (Phase 4).

    Incremental: only pages whose content changed since the last reindex are
    re-embedded/re-written; pages removed from disk are dropped from the
    index. A utility command (not one of the five headline verbs) that
    Phase 5's `query` relies on to keep retrieval fresh.

    Phase 6 re-embed migration path: this same command is how an existing
    vault picks up a new embedder (e.g. installing `[embeddings]` so
    `embeddings_backend="auto"` starts resolving to the real local
    `bge-small-en-v1.5` model instead of the zero-dependency `HashEmbedder`
    fallback, or explicitly setting `MYTHIC_EMBEDDINGS_BACKEND=fastembed`).
    `IndexStore` detects the embedder identity (`{ClassName}:{dim}`) changed
    against what's stored in `meta.embedder_id` and automatically wipes and
    rebuilds every vector from scratch on the next `reindex` -- no separate
    migration tool is needed, and nothing but vectors is ever discarded
    (page/FTS content is always re-derived from `wiki/` on disk).
    """
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    settings = load_settings(root)
    embedder = get_embedder(settings)
    with IndexStore(root, embedder) as store:
        report = store.reindex(root)

    console.print(
        f"[green]Reindexed:[/green] +{report.added} added, "
        f"~{report.updated} updated, -{report.deleted} deleted, "
        f"{report.unchanged} unchanged"
    )


@app.command("index-graph")
def index_graph(
    vault_path: Optional[Path] = typer.Option(
        None, "--vault", help="Vault whose GraphRAG data layer to sync (defaults to the current directory)."
    ),
    max_gleanings: int = typer.Option(
        1, "--max-gleanings", help="Max bounded 'did you miss any?' recall-loop rounds per text unit."
    ),
) -> None:
    """Build/sync the GraphRAG entity/relationship/claim knowledge graph (Phase 3).

    Chunks every RAW ingested source document (`raw/`, NOT the compiled
    `wiki/` summary pages) into text units, extracts entities/relationships/
    claims via the configured LLM provider (AuthHub by default; requires
    AUTHHUB_API_KEY, or a fully-local Ollama run via `local: true`) using
    prompted delimited-tuple output, and persists them alongside the
    existing SQLite hybrid-search sidecar. Incremental: only text units
    whose content changed since the last run are re-extracted (cached via
    `llm_cache`, so an unchanged vault costs zero LLM calls).

    A real LLM-cost operation (unlike `reindex`) -- this is why it stays a
    separate, explicit command rather than folded into `ingest`; the web
    UI's "Build Knowledge Graph" action and its optional
    "auto-build after ingest" Settings toggle (off by default) call this
    exact same `reindex_graph` machinery. Imports the extraction client
    lazily so the rest of the CLI never requires it. Was previously hidden
    from `--help` while orphaned (no UI entry point ever called it); now a
    documented, supported, UI-discoverable operation.
    """
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    settings = load_settings(root)
    embedder = get_embedder(settings)

    from mythic_proportion.graph.extract import ExtractionError
    from mythic_proportion.graph.index import GraphExtractionSetupError, build_extraction_client, reindex_graph

    try:
        client = build_extraction_client(settings)
    except GraphExtractionSetupError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc

    with IndexStore(root, embedder) as store:
        store.reindex(root)
        try:
            report = reindex_graph(
                root,
                store.conn,
                extraction_client=client,
                embedder=embedder,
                vec_active=store.vec_active,
                model=settings.llm_model,
                max_gleanings=max_gleanings,
            )
        except ExtractionError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(code=1) from exc

        # Phase 4: recompute the whole-graph Leiden clustering + community
        # reports on every `index-graph` run (cheap at personal-vault scale,
        # per specs/ROADMAP-BRIEF.md §6.2) -- never blocks graph-layer sync
        # if the optional `[graphrag]` extra (or its leidenalg fallback)
        # isn't installed; that failure is reported, not fatal. The
        # `except ImportError` below is scoped to *only* `compute_communities`
        # (the one call that lazily imports graspologic/leidenalg) -- it
        # deliberately does NOT wrap `generate_community_reports`, so any
        # unrelated ImportError raised during report generation propagates
        # as a real failure instead of being misreported as "optional
        # clustering backend absent".
        from mythic_proportion.graph.communities import compute_communities
        from mythic_proportion.graph.reports import generate_community_reports

        try:
            community_report = compute_communities(store.conn)
        except ImportError as exc:
            console.print(f"[yellow]Skipping community/report generation:[/yellow] {exc}")
        else:
            reports_report = generate_community_reports(
                store.conn,
                client=client,
                model=settings.llm_model,
                embedder=embedder,
                vec_active=store.vec_active,
            )
            console.print(
                f"[green]Communities:[/green] {community_report.rows_written} membership row(s) "
                f"across {community_report.levels} level(s) ({community_report.backend}); "
                f"{reports_report.reports_written} report(s) written, "
                f"{reports_report.llm_calls} LLM call(s)"
            )

    console.print(
        f"[green]Graph reindexed:[/green] +{report.text_units_added} text unit(s), "
        f"~{report.text_units_updated} updated, -{report.text_units_deleted} deleted, "
        f"{report.entities_upserted} entit(y/ies) upserted, "
        f"{report.relationships_upserted} relationship(s), {report.claims_upserted} claim(s), "
        f"{report.llm_calls} LLM call(s)"
    )


@app.command()
def query(
    question: str = typer.Argument(..., help="A question to ask the vault."),
    vault_path: Optional[Path] = typer.Option(
        None, "--vault", help="Vault to query (defaults to the current directory)."
    ),
    no_llm: bool = typer.Option(
        False,
        "--no-llm",
        help=(
            "Deprecated: LLM synthesis is now required. Passing --no-llm raises "
            "a clear 'LLM required' error instead of silently returning a "
            "degraded ranked-pages digest; use the Search view/`mythic reindex` "
            "+ direct index queries if you need pure offline retrieval."
        ),
    ),
    k: int = typer.Option(8, "-k", "--k", help="Number of pages to retrieve."),
    mode: str = typer.Option(
        "auto",
        "--mode",
        help=(
            "Retrieval mode: auto (default, preserves legacy behavior until the "
            "graph layer has data) | legacy | global | local | drift | activation."
        ),
    ),
) -> None:
    """Answer a question by retrieving and synthesizing from the vault."""
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    if no_llm:
        console.print(
            "[red]--no-llm is no longer supported: LLM synthesis is required "
            "(see AUTHHUB_API_KEY / MYTHIC_LLM_PROVIDER).[/red]"
        )
        raise typer.Exit(code=1)

    try:
        answer = answer_query(root, question, k=k, use_llm=True, mode=mode)
    except (AnswerError, ValueError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc

    console.print(f"[cyan]Question:[/cyan] {escape(question)}")
    console.print()
    # `answer.text` is plain data (may embed `[[Title]]` wikilink syntax whose
    # brackets Rich would otherwise mis-parse as (unclosed) style tags,
    # silently swallowing e.g. any lowercase-leading title) -- never markup.
    console.print(answer.text, markup=False)

    if answer.citations:
        console.print()
        console.print(
            "[green]Citations:[/green] "
            + escape(", ".join(f"[[{c}]]" for c in answer.citations))
        )

    if answer.hits:
        console.print()
        console.print("[yellow]Sources (ranked):[/yellow]")
        for hit in answer.hits:
            console.print(
                f"  - [[{hit.title}]] ({hit.tier}, score={hit.score:.3f}) -- {hit.page_path}",
                markup=False,
            )

    console.print()
    console.print(f"[dim]used_llm={answer.used_llm}[/dim]")


@app.command()
def lint(
    vault_path: Optional[Path] = typer.Argument(
        None, help="Vault to lint (defaults to the current directory)."
    ),
    fix: bool = typer.Option(False, "--fix", help="Auto-fix detected issues."),
) -> None:
    """Report orphan pages, broken wikilinks, and stale index rows."""
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    report = lint_vault(root)

    if fix and not report.ok:
        fix_result = lint_fix(root)
        console.print(
            f"[cyan]Fix applied:[/cyan] +{len(fix_result.stubs_created)} stub(s) created, "
            f"index +{fix_result.index_report.added}/~{fix_result.index_report.updated}"
            f"/-{fix_result.index_report.deleted}, hot.md refreshed={fix_result.hot_refreshed}"
        )
        report = lint_vault(root)

    # Plain data (page titles/paths, may embed `[[Title]]` wikilink syntax) --
    # never markup, for the same reason as the `query` command above.
    console.print(report.summary(), markup=False)
    raise typer.Exit(code=report.exit_code)


@app.command()
def watch(
    vault_path: Optional[Path] = typer.Argument(
        None, help="Vault to watch (defaults to the current directory)."
    ),
    settle: float = typer.Option(
        1.5, "--settle", help="Seconds of filesystem quiet before a drop is ingested (debounce window)."
    ),
    compile_: bool = typer.Option(
        True,
        "--compile/--no-compile",
        help="Compile newly ingested sources into wiki pages after each ingest cycle.",
    ),
) -> None:
    """Watch vault/drop/ in real time and trigger ingestion automatically.

    Foreground process; prints activity as sources are ingested/compiled.
    Press Ctrl-C to stop (clean shutdown). Requires the optional `watchdog`
    dependency: `pip install 'mythic-proportion[watch]'`.
    """
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    console.print(f"[cyan]Watching[/cyan] {(root / 'drop').resolve()} (settle={settle}s) -- Ctrl-C to stop")
    try:
        run_watch(root, settle=settle, compile=compile_, on_activity=console.print)
    except WatchDependencyError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc
    console.print("[yellow]Watcher stopped.[/yellow]")


@app.command()
def serve(
    vault_path: Optional[Path] = typer.Option(
        None, "--vault", help="Vault to serve (defaults to the current directory)."
    ),
    host: str = typer.Option("127.0.0.1", "--host", help="Interface to bind the local web server to."),
    port: int = typer.Option(8765, "--port", help="Port to bind the local web server to."),
    no_browser: bool = typer.Option(
        False, "--no-browser", help="Do not automatically open the URL in a web browser."
    ),
) -> None:
    """Serve a local web UI over the vault (drop zone, search, ask, graph, lint).

    Requires the optional `web` extra: `pip install 'mythic-proportion[web]'`.
    `fastapi`/`uvicorn` are imported lazily here (and inside
    `mythic_proportion.web.app`), so the rest of this five-verb CLI stays
    importable even when they are not installed.
    """
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    settings = load_settings(root)

    try:
        import uvicorn
    except ImportError as exc:
        console.print(
            "[red]The 'serve' command requires the optional 'web' extra: "
            "pip install 'mythic-proportion[web]'[/red]"
        )
        raise typer.Exit(code=1) from exc

    from mythic_proportion.web.app import create_app

    web_app = create_app(root, settings=settings)
    url = f"http://{host}:{port}/"
    console.print(f"[green]Serving[/green] {root.resolve()} at {url}")

    if not no_browser:
        import webbrowser

        webbrowser.open(url)

    uvicorn.run(web_app, host=host, port=port, log_level="info")


@app.command("ingest-harness", hidden=True)
def ingest_harness_cmd(
    harness_root: Path = typer.Option(
        ..., "--harness-root", help="Path to the FABLE-HARNESS root to pull artifacts from."
    ),
    vault_path: Optional[Path] = typer.Option(
        None, "--vault", help="Vault to ingest into (defaults to the current directory)."
    ),
    limit: int = typer.Option(
        DEFAULT_FABLE_ARTIFACT_LIMIT,
        "--fable-limit",
        help="Max number of most-recently-modified .fable/ artifacts to pull in.",
    ),
    compile_: bool = typer.Option(
        False,
        "--compile/--no-compile",
        help="Compile newly ingested harness artifacts into wiki pages.",
    ),
) -> None:
    """Copy specs/, memory/, and recent .fable/ artifacts from a harness root into
    drop/, then ingest them (see docs/harness-ingest.md). Optional convenience,
    not one of the five headline verbs -- hidden from --help."""
    root = Path(vault_path) if vault_path is not None else Path.cwd()
    collect_report, ingest_report = ingest_harness(
        harness_root, root, fable_artifact_limit=limit, compile=compile_
    )
    console.print(f"[green]Collected:[/green] {len(collect_report.copied)} file(s) from {harness_root}")
    if collect_report.skipped_missing:
        console.print(f"[yellow]Not found (skipped):[/yellow] {', '.join(collect_report.skipped_missing)}")
    console.print(f"[green]Ingested:[/green] {len(ingest_report.ingested)}")
    console.print(f"[yellow]Skipped (duplicates):[/yellow] {len(ingest_report.skipped)}")
    console.print(f"[red]Errors:[/red] {len(ingest_report.errors)}")


if __name__ == "__main__":
    app()
