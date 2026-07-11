"""FastAPI app factory for the local Mythic Proportion web UI (Phase 7).

``create_app`` is the single entry point (used by the CLI's ``serve`` command
and by ``tests/test_web.py``). Every route is a thin wrapper around the exact
same reusable building blocks the CLI already uses -- ``ingest_drop``,
``compile_source``, ``IndexStore``/``hybrid_search``, ``answer_query``,
``lint_vault``/``lint_fix`` -- so the web UI can never drift from CLI
behavior. ``fastapi`` is imported lazily, inside this function, so importing
this *module* (or the rest of the package) never requires the optional
``web`` extra to be installed; only actually calling :func:`create_app` does.
"""

import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from mythic_proportion.config import Settings, authhub_api_key, authhub_base_url, load_settings
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.retrieve import hybrid_search
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.lint import lint_fix, lint_vault
from mythic_proportion.web.jobs import _IDLE_STATE, IngestWorker
from mythic_proportion.web.pages import backlinks_index, collect_pages, title_to_path_index
from mythic_proportion.web.render import render_markdown, render_snippet_html

STATIC_DIR = Path(__file__).with_name("static")

#: Build output of the greenfield Vite/React/R3F workspace (``web/``), mounted
#: at ``/app`` when present (see ``vite.config.ts``: ``base: "/app/"``,
#: ``outDir: "../src/mythic_proportion/web/static_next"``). Deliberately a
#: *new*, sibling directory to the legacy ``static/`` -- the legacy SPA at
#: ``/`` is untouched (parity requirement, see specs/parity-checklist.md).
STATIC_NEXT_DIR = Path(__file__).with_name("static_next")

#: Providers ``POST /api/config`` will accept for ``llm_provider``.
_VALID_PROVIDERS = {"authhub", "anthropic"}

#: AuthHub's "list models" endpoint (sibling of the chat-completions path used
#: by :mod:`mythic_proportion.llm.authhub`).
_MODELS_PATH = "/api/v1/ai/models"


class QueryRequest(BaseModel):
    """Body for ``POST /api/query``."""

    question: str
    use_llm: bool = True
    k: int = 8
    #: Phase 4, CORRECTED per memory/invariants.md's "POST /api/query
    #: contract -- CORRECTION" entry: `mode` has NO DEFAULT. A request that
    #: omits this key entirely always takes the exact pre-Phase-4 legacy
    #: path (`api_query` below never even passes a mode through to
    #: `answer_query` in that case) -- unconditionally, regardless of graph
    #: state. Explicit "auto" opts in to heuristic dispatch; explicit
    #: "legacy"/"global"/"local"/"drift"/"activation" force that path. The
    #: Ask view's mode dropdown sends an explicit value; its own default
    #: (no selection) omits the key entirely.
    mode: str | None = None


class ConfigUpdateRequest(BaseModel):
    """Body for ``POST /api/config``.

    Deliberately has no field for the AuthHub/Anthropic API key -- keys stay
    env-only (``AUTHHUB_API_KEY``/``ANTHROPIC_API_KEY``), never accepted or
    stored via this endpoint.
    """

    model: str | None = None
    provider: str | None = None
    route_alias: str | None = None


def create_app(vault_root: Path, settings: Settings | None = None) -> Any:
    """Build a FastAPI app serving the JSON API + SPA for the vault at ``vault_root``.

    Raises ``RuntimeError`` with an install hint if ``fastapi``/``uvicorn``
    are not installed -- the rest of the package must remain importable
    without them.
    """
    try:
        from fastapi import FastAPI, File, HTTPException, UploadFile
        from fastapi.responses import HTMLResponse
        from fastapi.staticfiles import StaticFiles
    except ImportError as exc:  # pragma: no cover - exercised only when fastapi absent
        raise RuntimeError(
            "the web UI requires the optional 'web' extra: pip install 'mythic-proportion[web]'"
        ) from exc

    vault_root = Path(vault_root)
    settings = settings or load_settings(vault_root)

    app = FastAPI(
        title="Mythic Proportion",
        description="Local web UI over a Mythic Proportion vault.",
        version="0.1.0",
    )
    # `settings` is held as mutable app state (rather than closed over
    # directly) so `POST /api/config` can change the active model/provider at
    # runtime, with every route below reading `app.state.settings` picking up
    # the change immediately -- no restart required.
    app.state.settings = settings

    # Single-worker background ingest queue (see `web.jobs`): started here,
    # synchronously, rather than gated behind a FastAPI startup event, so it
    # is guaranteed running for every caller of `create_app` -- including
    # `fastapi.testclient.TestClient` used *without* the `with` context
    # manager (which is how every existing test in this package uses it;
    # starlette's TestClient only replays ASGI lifespan/startup events when
    # used as a context manager). `get_settings` reads `app.state.settings`
    # fresh every time a job runs, so a model/provider change via
    # `POST /api/config` mid-session applies to the next enqueued job.
    ingest_worker = IngestWorker(vault_root, get_settings=lambda: app.state.settings)
    ingest_worker.start()
    app.state.ingest_worker = ingest_worker

    @app.on_event("shutdown")
    def _shutdown_ingest_worker() -> None:
        app.state.ingest_worker.stop()

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # Greenfield Vite/React/R3F build (see web/vite.config.ts), mounted at
    # /app -- guarded so this no-ops entirely if `npm run build` has never
    # been run (e.g. a fresh clone without the web/ toolchain). The legacy
    # SPA at "/" above is unaffected either way (parity requirement).
    if STATIC_NEXT_DIR.is_dir():
        app.mount(
            "/app",
            StaticFiles(directory=str(STATIC_NEXT_DIR), html=True),
            name="static_next",
        )

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))

    @app.get("/api/pages")
    def api_pages() -> dict[str, Any]:
        pages = collect_pages(vault_root)
        backlinks = backlinks_index(pages)
        items = [
            {
                "path": page.path,
                "title": page.title,
                "type": page.page_type,
                "tags": page.tags,
                "link_count": len(page.outbound),
                "backlink_count": len(backlinks.get(page.title.lower(), [])),
            }
            for page in pages
        ]
        items.sort(key=lambda item: str(item["title"]).lower())
        return {"pages": items}

    @app.get("/api/page")
    def api_page(path: str) -> dict[str, Any]:
        pages = collect_pages(vault_root)
        title_to_path = title_to_path_index(pages)
        backlinks = backlinks_index(pages)

        page = next((p for p in pages if p.path == path), None)
        if page is None:
            raise HTTPException(status_code=404, detail=f"page not found: {path!r}")

        outbound = [
            {"title": target, "path": title_to_path.get(target.lower())} for target in page.outbound
        ]
        backlink_titles = backlinks.get(page.title.lower(), [])
        back = [
            {"title": title, "path": title_to_path.get(title.lower())} for title in sorted(set(backlink_titles))
        ]

        return {
            "path": page.path,
            "title": page.title,
            "type": page.page_type,
            "tags": page.tags,
            "frontmatter": page.frontmatter,
            "raw_markdown": page.body,
            "html": render_markdown(page.body, title_to_path),
            "outbound": outbound,
            "backlinks": back,
        }

    @app.get("/api/search")
    def api_search(q: str, k: int = 8) -> dict[str, Any]:
        embedder = get_embedder(app.state.settings)
        with IndexStore(vault_root, embedder) as store:
            store.reindex(vault_root)
            hits = hybrid_search(store, q, k=k)
        results = []
        for hit in hits:
            item = asdict(hit)
            # `snippet` carries raw <mark>/</mark>-delimited FTS5 output;
            # `snippet_html` is the pre-escaped, safe-to-inject-as-HTML form
            # (see `web.render.render_snippet_html`) the Search view uses.
            item["snippet_html"] = render_snippet_html(hit.snippet)
            results.append(item)
        return {"results": results}

    @app.post("/api/query")
    def api_query(req: QueryRequest) -> dict[str, Any]:
        # Binding contract (memory/invariants.md, "POST /api/query contract --
        # CORRECTION"): whether the request carried an explicit `mode` key is
        # a static property of THIS request, decided once, here -- never
        # re-derived from vault/graph state. `explicit_mode` gates every
        # place below that would add a new (strictly additive) response key.
        explicit_mode = req.mode is not None
        current_settings = app.state.settings
        try:
            answer = answer_query(
                vault_root,
                req.question,
                k=req.k,
                use_llm=req.use_llm,
                mode=req.mode,
                settings=current_settings,
            )
        except Exception as exc:  # noqa: BLE001 - the API must never 500 on a query
            # Still surface retrieval hits even when synthesis is unavailable,
            # so the user sees relevant pages rather than a bare error.
            embedder = get_embedder(current_settings)
            with IndexStore(vault_root, embedder) as store:
                store.reindex(vault_root)
                hits = hybrid_search(store, req.question, k=req.k)
            response: dict[str, Any] = {
                "text": f"LLM unavailable via AuthHub at {authhub_base_url(current_settings)}: {exc}",
                "citations": [],
                "hits": [asdict(hit) for hit in hits],
                "used_llm": False,
                "error": True,
            }
            if explicit_mode:
                # `resolved` is unknown here -- the exception may have been
                # raised before/without a mode resolution completing -- so
                # only `requested` (what the caller asked for) is surfaced.
                response["mode"] = req.mode
                response["mode_detail"] = {"requested": req.mode, "resolved": None}
                for hit in response["hits"]:
                    hit["source_kind"] = "page"
            return response

        response = {
            "text": answer.text,
            "citations": answer.citations,
            "hits": [asdict(hit) for hit in answer.hits],
            "used_llm": answer.used_llm,
            "error": False,
        }
        if explicit_mode:
            # Omitted-mode requests (`explicit_mode` False) never reach this
            # branch -- their response is exactly the legacy 5-key dict
            # above, with no `mode`/`mode_detail` keys and no `source_kind`
            # on any hit, per the binding legacy-shape contract.
            response["mode"] = req.mode
            response["mode_detail"] = {"requested": req.mode, "resolved": answer.resolved_mode}
            for hit in response["hits"]:
                hit["source_kind"] = "page"
        return response

    @app.get("/api/graph")
    def api_graph(mode: str = "wikilinks") -> dict[str, Any]:
        """`mode` selects which graph view to return:

        * `wikilinks` (default) -- the original [[wikilink]] page graph.
          Unchanged from before Phase 3: same node/edge shape, same query,
          never touches the GraphRAG tables at all.
        * `entities` -- the GraphRAG semantic graph (entity nodes, typed +
          weighted relationship edges) populated by `mythic index-graph`
          (empty nodes/edges if that has never been run).
        * `both` -- the union of the two, with `"kind": "page"|"entity"` on
          every node so callers can tell them apart.
        """
        if mode not in ("wikilinks", "entities", "both"):
            raise HTTPException(
                status_code=422, detail=f"invalid mode {mode!r}: expected one of wikilinks|entities|both"
            )

        pages = collect_pages(vault_root)
        title_to_path = title_to_path_index(pages)
        page_nodes = [{"id": page.path, "label": page.title, "type": page.page_type} for page in pages]
        page_edges: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for page in pages:
            for target_title in page.outbound:
                target_path = title_to_path.get(target_title.lower())
                if target_path is None or target_path == page.path:
                    continue
                key = (page.path, target_path)
                if key in seen:
                    continue
                seen.add(key)
                page_edges.append({"source": page.path, "target": target_path})

        if mode == "wikilinks":
            return {"nodes": page_nodes, "edges": page_edges}

        # `entities`/`both` read the GraphRAG tables from the same SQLite DB
        # `IndexStore` manages -- opened read-only-in-spirit here (embedder
        # `None` means this open never re-embeds/reindexes pages; it's just
        # a connection onto whatever `mythic index-graph` already wrote).
        # `sync_embedder=False` is load-bearing: without it, an
        # `embedder=None` open looks like an embedder-identity *change*
        # against a vault already indexed with a real embedder, and
        # `_sync_embedder_meta` wipes pages/pages_fts/page_vectors/vec_pages
        # as a result. This open must never touch that state.
        with IndexStore(vault_root, embedder=None, sync_embedder=False) as store:
            entity_nodes, entity_edges = GraphStore(store.conn).read_entity_graph()

        if mode == "entities":
            return {"nodes": entity_nodes, "edges": entity_edges}

        # mode == "both"
        kinded_page_nodes = [{**node, "kind": "page"} for node in page_nodes]
        return {"nodes": kinded_page_nodes + entity_nodes, "edges": page_edges + entity_edges}

    @app.post("/api/ingest")
    def api_ingest() -> dict[str, Any]:
        """Enqueue an ingest job for whatever is already in ``drop/`` and
        return its id immediately -- the actual ingest/compile/reindex work
        happens on the single background worker thread (see ``web.jobs``),
        never in this request. Poll ``GET /api/ingest/status`` for progress.
        """
        job_id = app.state.ingest_worker.enqueue()
        return {"job_id": job_id}

    @app.post("/api/upload")
    async def api_upload(files: list[UploadFile] = File(...)) -> dict[str, Any]:
        """Save uploaded files into ``drop/`` (fast, stays in this request),
        then enqueue an ingest job and return its id immediately -- compile
        happens on the background worker, not here. Poll
        ``GET /api/ingest/status`` for progress.
        """
        drop_dir = vault_root / "drop"
        drop_dir.mkdir(parents=True, exist_ok=True)
        saved: list[str] = []
        for upload in files:
            name = Path(upload.filename or "upload.bin").name  # strip any path components
            dest = drop_dir / name
            contents = await upload.read()
            dest.write_bytes(contents)
            saved.append(name)
        job_id = app.state.ingest_worker.enqueue()
        return {"job_id": job_id, "saved": saved}

    @app.get("/api/ingest/status")
    def api_ingest_status(job_id: str | None = None) -> dict[str, Any]:
        """Current state of one ingest job, or the most recently enqueued
        job if ``job_id`` is omitted. Never 500s: if no job has ever been
        enqueued (or an unknown ``job_id`` is given), returns an idle/empty
        state with ``done: true`` rather than erroring, so the frontend can
        poll unconditionally after boot.
        """
        job = app.state.ingest_worker.get_job(job_id)
        return job if job is not None else dict(_IDLE_STATE)

    @app.get("/api/jobs/{job_id}")
    def api_job(job_id: str) -> dict[str, Any]:
        job = app.state.ingest_worker.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"job not found: {job_id!r}")
        return job

    @app.get("/api/lint")
    def api_lint() -> dict[str, Any]:
        report = lint_vault(vault_root)
        return {
            "ok": report.ok,
            "exit_code": report.exit_code,
            "summary": report.summary(),
            "orphans": [asdict(o) for o in report.orphans],
            "dangling_links": [asdict(d) for d in report.dangling_links],
            "stale_index_entries": [asdict(s) for s in report.stale_index_entries],
            "thin_pages": [asdict(t) for t in report.thin_pages],
        }

    @app.post("/api/lint/fix")
    def api_lint_fix() -> dict[str, Any]:
        fix_result = lint_fix(vault_root, settings=app.state.settings)
        report = lint_vault(vault_root)
        return {
            "stubs_created": fix_result.stubs_created,
            "index_report": asdict(fix_result.index_report),
            "hot_refreshed": fix_result.hot_refreshed,
            "report": {
                "ok": report.ok,
                "exit_code": report.exit_code,
                "summary": report.summary(),
            },
        }

    @app.get("/api/config")
    def api_config() -> dict[str, Any]:
        current_settings = app.state.settings
        return {
            "provider": current_settings.llm_provider,
            "model": current_settings.llm_model,
            "authhub_base_url": authhub_base_url(current_settings),
            "route_alias": current_settings.route_alias,
            "has_api_key": bool(authhub_api_key())
            if current_settings.llm_provider == "authhub"
            else bool(os.environ.get("ANTHROPIC_API_KEY")),
        }

    @app.post("/api/config")
    def api_config_update(req: ConfigUpdateRequest) -> dict[str, Any]:
        current_settings = app.state.settings
        update: dict[str, Any] = {}

        if req.provider is not None:
            if req.provider not in _VALID_PROVIDERS:
                raise HTTPException(
                    status_code=422,
                    detail=f"invalid provider {req.provider!r}: expected one of {sorted(_VALID_PROVIDERS)}",
                )
            update["llm_provider"] = req.provider

        if req.model is not None:
            if not req.model.strip():
                raise HTTPException(status_code=422, detail="model must be a non-empty string")
            update["llm_model"] = req.model

        if req.route_alias is not None:
            update["route_alias"] = req.route_alias or None

        if update:
            app.state.settings = current_settings.model_copy(update=update)

        return api_config()

    @app.get("/api/models")
    def api_models() -> dict[str, Any]:
        current_settings = app.state.settings
        base_url = authhub_base_url(current_settings)
        api_key = authhub_api_key()
        result: dict[str, Any] = {
            "models": [],
            "current": current_settings.llm_model,
            "provider": current_settings.llm_provider,
        }
        if not api_key:
            result["error"] = "AUTHHUB_API_KEY is not set: falling back to free-text model entry"
            return result

        try:
            import httpx
        except ImportError:
            result["error"] = "the 'authhub' extra is not installed: pip install 'mythic-proportion[authhub]'"
            return result

        try:
            response = httpx.get(
                f"{base_url}{_MODELS_PATH}",
                headers={"X-API-Key": api_key},
                timeout=5.0,
            )
            response.raise_for_status()
            data = response.json()
            models = [item["id"] for item in data.get("data", []) if isinstance(item, dict) and "id" in item]
            result["models"] = models
        except Exception as exc:  # noqa: BLE001 - this endpoint must never 500
            result["error"] = f"could not reach AuthHub at {base_url}: {exc}"

        return result

    return app
