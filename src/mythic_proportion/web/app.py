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

import json
import os
import shutil
import tempfile
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel

from mythic_proportion.config import Settings, authhub_api_key, authhub_base_url, load_settings
from mythic_proportion.graph.communities import project_node_enrichment
from mythic_proportion.graph.store import GraphStore
from mythic_proportion.graph.tuples import normalize_title
from mythic_proportion.index.embeddings import get_embedder
from mythic_proportion.index.retrieve import hybrid_search
from mythic_proportion.index.store import IndexStore
from mythic_proportion.query.engine import answer_query
from mythic_proportion.vault.lint import lint_fix, lint_vault
from mythic_proportion.web.jobs import _GRAPH_IDLE_STATE, _IDLE_STATE, IngestWorker
from mythic_proportion.web.pages import backlinks_index, collect_pages, title_to_path_index
from mythic_proportion.web.render import render_markdown, render_snippet_html

STATIC_DIR = Path(__file__).with_name("static")

#: Build output of the greenfield Vite/React/R3F workspace (``web/``), mounted
#: at ``/app`` when present (see ``vite.config.ts``: ``base: "/app/"``,
#: ``outDir: "../src/mythic_proportion/web/static_next"``). Deliberately a
#: *new*, sibling directory to the legacy ``static/`` -- the legacy SPA at
#: ``/`` is untouched (parity requirement, see specs/parity-checklist.md).
STATIC_NEXT_DIR = Path(__file__).with_name("static_next")

#: Providers ``POST /api/config`` will accept for ``llm_provider``. Phase 6
#: adds ``"ollama"`` (a fully-local model via a local Ollama daemon -- see
#: :mod:`mythic_proportion.llm.ollama`).
_VALID_PROVIDERS = {"authhub", "anthropic", "ollama"}

#: AuthHub's "list models" endpoint (sibling of the chat-completions path used
#: by :mod:`mythic_proportion.llm.authhub`).
_MODELS_PATH = "/api/v1/ai/models"

# ---------------------------------------------------------------------------
# Security hardening (Phase 3, Section 6.2(a)): CORS + CSRF + an upload cap.
# ---------------------------------------------------------------------------

#: Known local origins this app is actually served/developed from: the
#: built/prod SPA served by `mythic serve` (default `127.0.0.1:8765`) and the
#: Vite dev server (default `localhost:5173`) -- both `127.0.0.1` and
#: `localhost` forms, since browsers treat them as distinct origins. This is
#: intentionally a small, closed allowlist, not a wildcard: this app is a
#: local single-user tool with no legitimate cross-origin caller.
ALLOWED_ORIGINS: frozenset[str] = frozenset(
    {
        "http://127.0.0.1:8765",
        "http://localhost:8765",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    }
)

#: Every state-changing `/api/*` POST route (Section 6.2(a)/3.3). Reads
#: (`GET`) are never CSRF-protected -- browsers don't need same-origin
#: confirmation to *read* a response their own script can't access
#: cross-origin anyway (that's CORS's job); the concrete risk this closes is
#: a malicious page tricking the browser into *sending* one of these
#: mutating requests to a locally-running server.
CSRF_PROTECTED_PATHS: frozenset[str] = frozenset(
    {"/api/upload", "/api/ingest", "/api/index-graph", "/api/lint/fix", "/api/config"}
)

#: Generous cap for personal-vault documents (Markdown, PDFs, etc.) dropped
#: via `POST /api/upload` -- large enough for real source material, small
#: enough to stop an accidental or hostile multi-GB request from filling the
#: disk / tying up the single-worker ingest queue.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _active_provider_label(settings: Settings) -> str:
    """A human-readable label for whichever provider ``settings`` actually
    routes through right now -- mirrors the exact same precedence
    ``query.engine._default_client``/``_default_extraction_client`` use
    (``local`` wins unconditionally, then explicit ``llm_provider``).
    Browser-audit item 4 (trust finding): used so an error message never
    hardcodes "via AuthHub" when the real active provider is Ollama or
    Anthropic."""
    if settings.local or settings.llm_provider == "ollama":
        return f"Ollama at {settings.ollama_base_url}"
    if settings.llm_provider == "anthropic":
        return "Anthropic"
    return f"AuthHub at {authhub_base_url(settings)}"


def _merge_page_backed_entities(
    page_nodes: list[dict[str, Any]],
    page_edges: list[dict[str, str]],
    entity_nodes: list[dict[str, Any]],
    entity_edges: list[dict[str, Any]],
    page_source_hashes: dict[str, str],
    entity_source_stems: dict[str, set[str]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Identity dedup for ``GET /api/graph?mode=both`` (T3 advisory H1, the
    confirmed root cause of the "Meridian Logistics" framing defect): the raw
    union shows any wiki-page-backed entity as TWO same-labeled nodes -- a
    page node (id = file path) and an entity node (id = ``entity:<int>``) --
    at two different force-layout positions. When the page twin is isolated
    (its body uses no ``[[wikilinks]]``), clicking it framed a degenerate
    one-point set on an unrelated patch of space with no edge in sight.

    Identity requires BOTH conditions (Codex CODE_REVIEW finding J-001: a
    title-string match alone is NOT identity -- a page coincidentally sharing
    a title with an unrelated, independently-extracted entity must never be
    fused, since fusing silently misattributes the entity's relationships and
    enrichment to the wrong page):

    1. **Unambiguous title match**: the page node and entity node's
       ``normalize_title`` keys match **exactly 1:1**.
    2. **Shared extraction provenance**: ``page_source_hashes[page id]`` (the
       page's frontmatter ``source_hash`` -- the content hash of the ingested
       raw document the compile pipeline generated the page from) names a
       document stem in ``entity_source_stems[entity id]`` (the stems of the
       ``text_units.page_path`` documents, e.g. ``raw/<content-hash>.md``,
       the entity was actually extracted from -- see
       ``GraphStore.entity_source_page_paths``). A hand-authored page (no
       ``source_hash``) or an entity extracted only from other documents
       therefore never merges, by construction.

    A qualifying pair merges into one node:

    * The **page** node survives unchanged (id/label/type/kind) -- its path id
      is load-bearing client-side (reading-pane fetch, Open-in-Wiki, Cmd+K
      graph jump all use page paths as node ids).
    * The entity twin's additive enrichment (``community``/``level``/
      ``centrality``/``parentCommunity``, when projected) rides onto the
      merged node, plus an ``entityId`` marker naming the absorbed twin. The
      entity-only ``degree`` field is deliberately dropped: it counts only
      relationship edges, so the client's own union-edge count (its documented
      fallback when ``degree`` is absent) is the correct value here.
    * The entity twin's edges are remapped onto the page id. A page
      (wikilink) edge whose (source, target) pair collides with a remapped
      relationship edge is dropped in favor of the richer typed/weighted one.

    An ambiguous match (several pages sharing a title, or several entities --
    e.g. one title under two types) is never merged, regardless of
    provenance: identity cannot be resolved safely, so those nodes pass
    through exactly as before.
    """
    pages_by_key: dict[str, list[dict[str, Any]]] = {}
    for node in page_nodes:
        key = normalize_title(str(node["label"]))
        if key:
            pages_by_key.setdefault(key, []).append(node)
    entities_by_key: dict[str, list[dict[str, Any]]] = {}
    for node in entity_nodes:
        key = normalize_title(str(node["label"]))
        if key:
            entities_by_key.setdefault(key, []).append(node)

    id_remap: dict[str, str] = {}
    extras_by_page_id: dict[str, dict[str, Any]] = {}
    for key, pages in pages_by_key.items():
        entities = entities_by_key.get(key)
        if entities is None or len(pages) != 1 or len(entities) != 1:
            continue
        page, entity = pages[0], entities[0]
        # J-001 provenance gate: the title match above is necessary but not
        # sufficient -- the page must have been compiled from a document the
        # entity was actually extracted from.
        source_hash = page_source_hashes.get(page["id"])
        if not source_hash or source_hash not in entity_source_stems.get(entity["id"], set()):
            continue
        id_remap[entity["id"]] = page["id"]
        extra = {k: v for k, v in entity.items() if k not in ("id", "label", "type", "kind", "degree")}
        extra["entityId"] = entity["id"]
        extras_by_page_id[page["id"]] = extra

    nodes: list[dict[str, Any]] = []
    for node in page_nodes:
        merged_extra = extras_by_page_id.get(node["id"])
        nodes.append({**node, **merged_extra} if merged_extra else node)
    nodes.extend(node for node in entity_nodes if node["id"] not in id_remap)

    remapped_entity_edges: list[dict[str, Any]] = []
    entity_pairs: set[tuple[str, str]] = set()
    for edge in entity_edges:
        source = id_remap.get(edge["source"], edge["source"])
        target = id_remap.get(edge["target"], edge["target"])
        if source == target:
            continue  # defensive: a merge must never manufacture a self-loop
        remapped_entity_edges.append({**edge, "source": source, "target": target})
        entity_pairs.add((source, target))

    kept_page_edges: list[dict[str, Any]] = [
        edge for edge in page_edges if (edge["source"], edge["target"]) not in entity_pairs
    ]
    return nodes, kept_page_edges + remapped_entity_edges


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
    #: Phase 6 additions -- all strictly additive/optional; omitting them
    #: leaves the corresponding setting untouched, exactly like the
    #: pre-existing fields above.
    local: bool | None = None
    redaction_enabled: bool | None = None
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    #: Bugfix DEFECT 1 (wiring gap) addition -- strictly additive/optional,
    #: same shape as the other Phase 6 toggles above.
    auto_build_graph: bool | None = None


class _UploadSizeLimitMiddleware:
    """Pure-ASGI middleware -- raw ``scope``/``receive``/``send``, not
    Starlette's ``Request``-based ``@app.middleware("http")``, which would
    require fully buffering the request body into a ``Request`` object
    before any of *our* code ever saw it, defeating the point -- that
    counts bytes as they stream in from the ASGI server for
    ``POST /api/upload`` specifically, and aborts with 413 the moment the
    cumulative body size exceeds ``max_bytes``, BEFORE Starlette's
    multipart parser (triggered by FastAPI's ``UploadFile`` dependency
    injection, which fully parses the body before the route handler ever
    runs) ever sees the excess bytes.

    Closes Codex J-001 (upload resource exhaustion, Section 6.2(a)
    remediation cycle): the previous ``Content-Length`` header check plus a
    post-hoc per-file byte tally inside the route handler both ran only
    AFTER ``UploadFile`` DI had already fully parsed the request body -- a
    missing/understated ``Content-Length`` with a large actual body could
    exhaust memory/disk before either check ever fired. This buffers at
    most ``max_bytes`` (plus one final chunk) in memory before either
    replaying it to the app (under budget) or rejecting outright (over
    budget) -- never the whole, unbounded body.

    Defined at module level, importing nothing from ``fastapi``/
    ``starlette`` (raw ASGI dict messages only), matching this module's own
    "importable without the ``web`` extra" contract.
    """

    def __init__(self, app: Any, *, max_bytes: int, path: str = "/api/upload") -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.path = path

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") != self.path:
            await self.app(scope, receive, send)
            return

        buffered: list[dict[str, Any]] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                buffered.append(message)
                break
            total += len(message.get("body", b"")) if isinstance(message.get("body"), (bytes, bytearray)) else 0
            if total > self.max_bytes:
                detail = f"upload too large: exceeds the {self.max_bytes}-byte cap"
                body = json.dumps({"detail": detail}).encode("utf-8")
                await send(
                    {
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                # Drain any remaining body chunks off the wire so the ASGI
                # server doesn't hang waiting for us to consume them.
                while message.get("more_body", False):
                    message = await receive()
                return
            buffered.append(message)
            if not message.get("more_body", False):
                break

        buffer_iter = iter(buffered)

        async def replay_receive() -> dict[str, Any]:
            try:
                return next(buffer_iter)
            except StopIteration:
                return await receive()

        await self.app(scope, replay_receive, send)


def create_app(vault_root: Path, settings: Settings | None = None) -> Any:
    """Build a FastAPI app serving the JSON API + SPA for the vault at ``vault_root``.

    Raises ``RuntimeError`` with an install hint if ``fastapi``/``uvicorn``
    are not installed -- the rest of the package must remain importable
    without them.
    """
    try:
        from fastapi import FastAPI, File, HTTPException, Request, UploadFile
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
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

    # CORS (Section 6.2(a)): locked down to the known local origins above --
    # never a wildcard. `allow_credentials=False` because this app uses no
    # cookies/session auth at all (every credential is env-only, read
    # server-side -- see `config.authhub_api_key`); leaving it `False` also
    # keeps the CORS spec's "no wildcard + credentials" restriction moot.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(ALLOWED_ORIGINS),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    # Codex J-001 remediation: streams-and-counts `/api/upload`'s request
    # body BEFORE FastAPI's `UploadFile` dependency injection ever parses
    # it -- see `_UploadSizeLimitMiddleware`'s own docstring for why the
    # in-handler checks below are no longer the primary enforcement point.
    app.add_middleware(_UploadSizeLimitMiddleware, max_bytes=MAX_UPLOAD_BYTES)

    @app.middleware("http")
    async def _csrf_protection(request: Request, call_next):  # type: ignore[no-untyped-def]
        """CSRF check for state-changing `/api/*` POST routes (Section
        6.2(a)/3.3). CORS alone only stops a cross-origin page's script from
        *reading* this app's response -- it does not stop the browser from
        *sending* a same-request-shape POST in the first place (e.g. a bare
        `fetch`/`<form>` submit, which isn't blocked by CORS pre-send). This
        origin/referer check closes that gap: a real browser always sends an
        `Origin` (or, failing that, `Referer`) header on a cross-origin POST,
        and increasingly on same-origin POSTs too; a request whose declared
        origin doesn't match one of `ALLOWED_ORIGINS` is rejected outright.
        A request with *neither* header present (curl, a non-browser local
        client, `TestClient`) is allowed through -- this is a browser-CSRF
        defense specifically, not a general auth boundary (this app has none
        -- see the CORS comment above), and every non-browser caller already
        has direct, unmediated access to the same local API regardless.
        """
        if request.method == "POST" and request.url.path in CSRF_PROTECTED_PATHS:
            candidate = request.headers.get("origin")
            if candidate is None:
                referer = request.headers.get("referer")
                if referer:
                    parsed = urlsplit(referer)
                    if parsed.scheme and parsed.netloc:
                        candidate = f"{parsed.scheme}://{parsed.netloc}"
            if candidate is not None and candidate not in ALLOWED_ORIGINS:
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": (
                            f"CSRF check failed: origin {candidate!r} is not an allowed local origin"
                        )
                    },
                )
        return await call_next(request)

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
    #
    # Browser-audit item 2 (BLOCKING): a plain `StaticFiles(html=True)`
    # mount only serves `index.html` for the mount root itself -- a direct
    # URL or hard refresh on any client-side SPA sub-route (`/app/graph`,
    # `/app/search`, ...) isn't a real file under `static_next/`, so it 404s
    # with the raw backend `{"detail": "Not Found"}` instead of ever
    # reaching React Router. This is the standard SPA-fallback pattern
    # instead: a real file under `static_next/` (including any hashed
    # `assets/*` build chunk) is served as-is; anything else under `/app`
    # falls back to `index.html`, letting the client-side router resolve
    # the actual route -- EXCEPT a missing `assets/*` path, which stays a
    # genuine 404 rather than being silently masked as a working route.
    if STATIC_NEXT_DIR.is_dir():
        static_next_root = STATIC_NEXT_DIR.resolve()

        @app.get("/app")
        @app.get("/app/{full_path:path}")
        def spa_app(full_path: str = "") -> Any:
            candidate = (STATIC_NEXT_DIR / full_path).resolve()
            try:
                candidate.relative_to(static_next_root)
            except ValueError:
                # Path-traversal attempt (e.g. `/app/../../etc/passwd`) --
                # never serve anything outside static_next/.
                raise HTTPException(status_code=404, detail="Not Found") from None
            if candidate.is_file():
                return FileResponse(candidate)
            # Codex J-003 (remediation cycle): only fall back to `index.html`
            # for a genuine bare client-side route (e.g. `/app/graph`) --
            # anything that LOOKS like a reference to a static file (lives
            # under `assets/`, or its final path segment carries a file
            # extension, e.g. `favicon.ico`, `manifest.webmanifest`, a
            # missing root-level `.css`/`.js`) must stay a real 404 when
            # missing. The previous `assets/`-only check silently served
            # `index.html` (200) for any OTHER missing static reference,
            # masking a genuinely broken/stale one instead of surfacing it.
            # A dotfile-style final segment (e.g. `.well-known/...`) is
            # deliberately NOT treated as file-shaped -- it has no
            # extension of its own, just a leading dot.
            last_segment = full_path.rsplit("/", 1)[-1]
            looks_like_a_static_file = full_path.startswith("assets/") or (
                "." in last_segment and not last_segment.startswith(".")
            )
            if looks_like_a_static_file:
                raise HTTPException(status_code=404, detail=f"not found: {full_path!r}")
            return FileResponse(STATIC_NEXT_DIR / "index.html")

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
                # Browser-audit item 4 (trust finding): this message used to
                # hardcode "via AuthHub" unconditionally, regardless of which
                # provider was actually configured/attempted -- misleading
                # when the active provider was Ollama (local mode) or
                # Anthropic. `_active_provider_label` reports the real one.
                "text": f"LLM unavailable via {_active_provider_label(current_settings)}: {exc}",
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
          every node so callers can tell them apart. A wiki-page-backed
          entity (page title and entity title normalize identically, 1:1) is
          returned as ONE merged node, not two same-labeled twins -- see
          :func:`_merge_page_backed_entities` for the full dedup contract.
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
            graph_store = GraphStore(store.conn)
            entity_nodes, entity_edges = graph_store.read_entity_graph()
            # mode=both identity-dedup input (Codex J-001 provenance gate):
            # each entity's extraction-source document stems, matched below
            # against page frontmatter `source_hash` values. Read inside this
            # same store open; skipped entirely for mode=entities.
            entity_source_stems: dict[str, set[str]] = {}
            if mode == "both":
                entity_source_stems = {
                    f"entity:{entity_id}": {PurePosixPath(page_path).stem for page_path in paths}
                    for entity_id, paths in graph_store.entity_source_page_paths().items()
                }
            # Phase 4b (plan Section 6.4/7): additive per-node Leiden
            # community/level/centrality projection -- a PROJECTION of
            # already-computed data (`graph/communities.py`,
            # `store.community_memberships`/`max_community_level`), never new
            # graph computation. Entities absent from the `communities` table
            # (e.g. never Leiden-clustered, or `mythic index-graph` has never
            # run) simply get no extra keys here -- the response shape stays
            # byte-identical to the pre-Phase-4b shape for those nodes, which
            # is exactly what lets the client's `deriveVizGraph` fall back to
            # its own union-find grouping (plan Section 7's backward-
            # compatibility requirement).
            entity_ids = [int(node["id"].removeprefix("entity:")) for node in entity_nodes]
            enrichment = project_node_enrichment(store.conn, entity_ids)
            for node, entity_id in zip(entity_nodes, entity_ids):
                extra = enrichment.get(entity_id)
                if extra is not None:
                    node.update(extra)

        if mode == "entities":
            return {"nodes": entity_nodes, "edges": entity_edges}

        # mode == "both": identity-dedup the union so a wiki-page-backed
        # entity appears exactly once (see _merge_page_backed_entities --
        # requires BOTH a 1:1 title match and shared extraction provenance).
        page_source_hashes: dict[str, str] = {}
        for page in pages:
            raw_source_hash = page.frontmatter.get("source_hash")
            if raw_source_hash:
                page_source_hashes[page.path] = str(raw_source_hash)
        kinded_page_nodes = [{**node, "kind": "page"} for node in page_nodes]
        merged_nodes, merged_edges = _merge_page_backed_entities(
            kinded_page_nodes,
            page_edges,
            entity_nodes,
            entity_edges,
            page_source_hashes,
            entity_source_stems,
        )
        return {"nodes": merged_nodes, "edges": merged_edges}

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
    async def api_upload(request: Request, files: list[UploadFile] = File(...)) -> dict[str, Any]:
        """Save uploaded files into ``drop/`` (fast, stays in this request),
        then enqueue an ingest job and return its id immediately -- compile
        happens on the background worker, not here. Poll
        ``GET /api/ingest/status`` for progress.

        Section 6.2(a): the request body is capped at :data:`MAX_UPLOAD_BYTES`
        by ``_UploadSizeLimitMiddleware``, which streams and counts the raw
        ASGI body BEFORE ``UploadFile`` dependency injection (i.e. before
        this function even starts running) ever parses it -- see that
        class's docstring (Codex J-001 remediation). The
        ``Content-Length``/byte-tally checks below are now a cheap,
        redundant defense-in-depth backstop, not the primary guard.

        Codex J-002 remediation (atomicity): every file in the request is
        first written to a private temporary staging directory; only once
        ALL of them have staged successfully are they moved into ``drop/``.
        Any failure partway through (the cap, a write error, anything)
        leaves ``drop/`` completely untouched -- no partial upload can land
        there for a request that ultimately fails, where a later
        ``/api/ingest`` call might otherwise silently pick it up. The
        staging directory itself is always cleaned up (success or failure).
        """
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"upload too large: exceeds the {MAX_UPLOAD_BYTES}-byte cap",
                    )
            except ValueError:
                pass  # malformed header -- fall through to the byte-count backstop below

        drop_dir = vault_root / "drop"
        drop_dir.mkdir(parents=True, exist_ok=True)
        staged: list[tuple[Path, str]] = []
        total_bytes = 0
        with tempfile.TemporaryDirectory(prefix="mp-upload-staging-") as staging_dir_str:
            staging_dir = Path(staging_dir_str)
            for upload in files:
                name = Path(upload.filename or "upload.bin").name  # strip any path components
                contents = await upload.read()
                total_bytes += len(contents)
                if total_bytes > MAX_UPLOAD_BYTES:
                    # `TemporaryDirectory`'s context manager cleans up every
                    # staged file below on this early return -- nothing
                    # partial ever reaches `drop/`.
                    raise HTTPException(
                        status_code=413,
                        detail=f"upload too large: exceeds the {MAX_UPLOAD_BYTES}-byte cap",
                    )
                staged_path = staging_dir / name
                staged_path.write_bytes(contents)
                staged.append((staged_path, name))

            # Every file staged successfully -- now, and only now, move each
            # into `drop/`. `shutil.move` is safe across the staging
            # tempdir's filesystem and the vault's own (possibly different
            # drive on Windows), and each move is effectively instantaneous
            # local disk I/O, so this window is as small as it can be. If
            # a LATER move still fails partway through this loop (a real
            # I/O error, not a cap trip), roll back every file that DID
            # already land in `drop/` before re-raising -- a request that
            # ultimately fails must never leave a partial upload behind for
            # a later `/api/ingest` call to silently pick up.
            saved: list[str] = []
            moved_dests: list[Path] = []
            try:
                for staged_path, name in staged:
                    dest = drop_dir / name
                    shutil.move(str(staged_path), str(dest))
                    moved_dests.append(dest)
                    saved.append(name)
            except OSError as exc:
                for dest in moved_dests:
                    dest.unlink(missing_ok=True)
                raise HTTPException(status_code=500, detail=f"upload failed: {exc}") from exc

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

    @app.post("/api/index-graph")
    def api_index_graph() -> dict[str, Any]:
        """Enqueue a "Build Knowledge Graph" job -- the web UI's equivalent
        of `mythic index-graph` (bugfix DEFECT 1: that command previously
        had no real entry point at all). Runs on the same single background
        worker thread as ingest jobs (never concurrently with one), for the
        same CPU-stampede/write-race reasons `web.jobs.IngestWorker`
        already documents for ingest. Poll `GET /api/index-graph/status`
        for progress; a real LLM-cost operation, so this is only ever
        triggered explicitly (this endpoint) or via the opt-in
        `auto_build_graph` Settings toggle after an ingest job.
        """
        job_id = app.state.ingest_worker.enqueue_graph()
        return {"job_id": job_id}

    @app.get("/api/index-graph/status")
    def api_index_graph_status(job_id: str | None = None) -> dict[str, Any]:
        """Current state of one graph-build job, or the most recently
        enqueued one if `job_id` is omitted. Never 500s: mirrors
        `GET /api/ingest/status`'s idle-state contract."""
        job = app.state.ingest_worker.get_graph_job(job_id)
        return job if job is not None else dict(_GRAPH_IDLE_STATE)

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
        # Phase 6: `local: true` routes everything through Ollama and never
        # touches the cloud -- `has_api_key` reflects that (Ollama needs no
        # API key at all; it's a reachability question, not a credential
        # one, so we simply omit any cloud-key claim in that case).
        if current_settings.local or current_settings.llm_provider == "ollama":
            has_api_key = True
        elif current_settings.llm_provider == "authhub":
            has_api_key = bool(authhub_api_key())
        else:
            has_api_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
        # Browser-audit item 4 (trust finding): `local: true` overrides
        # routing to Ollama unconditionally (see
        # `query.engine._default_client`'s docstring -- that enforcement was
        # already correct), but the raw `provider`/`model` fields below stay
        # untouched by that override (so turning `local` back off restores
        # them). Without a distinct "what's actually active right now"
        # field, a client (the Ask view's model hint, in particular) had no
        # way to show anything other than the raw stored fields -- e.g.
        # "deepseek-chat (authhub)" -- even while `local: true` meant every
        # real call was routed to Ollama, which read as "local mode isn't
        # enforced" even though the actual routing always was. These two
        # additive fields are the fix: the actually-active provider/model.
        effective_local = current_settings.local or current_settings.llm_provider == "ollama"
        effective_provider = "ollama" if effective_local else current_settings.llm_provider
        effective_model = current_settings.ollama_model if effective_local else current_settings.llm_model
        return {
            "provider": current_settings.llm_provider,
            "model": current_settings.llm_model,
            "authhub_base_url": authhub_base_url(current_settings),
            "route_alias": current_settings.route_alias,
            "has_api_key": has_api_key,
            # Phase 6 additions -- strictly additive.
            "local": current_settings.local,
            "redaction_enabled": current_settings.redaction_enabled,
            "ollama_base_url": current_settings.ollama_base_url,
            "ollama_model": current_settings.ollama_model,
            "embeddings_backend": current_settings.embeddings_backend,
            # Bugfix DEFECT 1 addition -- strictly additive.
            "auto_build_graph": current_settings.auto_build_graph,
            # Browser-audit item 4 additions -- strictly additive.
            "effective_provider": effective_provider,
            "effective_model": effective_model,
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

        if req.local is not None:
            update["local"] = req.local

        if req.redaction_enabled is not None:
            update["redaction_enabled"] = req.redaction_enabled

        if req.auto_build_graph is not None:
            update["auto_build_graph"] = req.auto_build_graph

        if req.ollama_base_url is not None:
            if not req.ollama_base_url.strip():
                raise HTTPException(status_code=422, detail="ollama_base_url must be a non-empty string")
            update["ollama_base_url"] = req.ollama_base_url

        if req.ollama_model is not None:
            if not req.ollama_model.strip():
                raise HTTPException(status_code=422, detail="ollama_model must be a non-empty string")
            update["ollama_model"] = req.ollama_model

        # Phase 6 fix (closes a prior review finding): `local: true` with a
        # non-loopback `ollama_base_url` would egress prompts off-host. Validate
        # the *effective* post-update state -- whether `local` or
        # `ollama_base_url` (or neither, i.e. an already-local vault) is the
        # field actually being changed in this request -- and reject rather
        # than silently accepting a remote URL. This is the config-set-time
        # half of the enforcement; `compile.pipeline`/`query.engine`'s
        # `_default_client` factories enforce the same rule again at
        # client-construction time.
        #
        # Retry fix (closes a second prior review finding): the original
        # check only fired when `effective_local` was true, so
        # `provider="ollama", local=False` could persist a non-loopback
        # `ollama_base_url` via this endpoint -- e.g. an admin sets
        # `provider=ollama` first and `ollama_base_url` in a later request
        # with `local` never touched (still `False`). The construction-time
        # guard in `compile.pipeline`/`query.engine`'s `_default_client`
        # still refused to actually egress in that case (both branches route
        # through Ollama whenever `local or llm_provider == "ollama"`), so
        # this was never a real network bypass -- but it left a stale,
        # invalid `ollama_base_url` sitting in config, which is itself the
        # invariant this config-time check exists to close. Now validated
        # whenever *either* `local` or `llm_provider` resolves to routing
        # through Ollama.
        effective_local = update.get("local", current_settings.local)
        effective_provider = update.get("llm_provider", current_settings.llm_provider)
        effective_ollama_base_url = update.get("ollama_base_url", current_settings.ollama_base_url)
        if effective_local or effective_provider == "ollama":
            from mythic_proportion.llm.ollama import OllamaConfigError, require_loopback_url

            context = (
                "POST /api/config (local=True)"
                if effective_local
                else "POST /api/config (provider=ollama)"
            )
            try:
                require_loopback_url(effective_ollama_base_url, context=context)
            except OllamaConfigError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        if update:
            app.state.settings = current_settings.model_copy(update=update)

        return api_config()

    @app.get("/api/models")
    def api_models() -> dict[str, Any]:
        current_settings = app.state.settings
        result: dict[str, Any] = {
            "models": [],
            "current": current_settings.llm_model,
            "provider": current_settings.llm_provider,
        }
        # Browser-audit item 4 (contradictory-copy finding): this endpoint
        # only ever lists AuthHub's model catalog, so it must not report an
        # "AUTHHUB_API_KEY is not set" error when the active provider isn't
        # even routed through AuthHub -- that's exactly what previously
        # produced the observed contradiction ("AUTHHUB_API_KEY is not set"
        # displayed directly alongside "An API key is configured for this
        # provider", which `/api/config`'s `has_api_key` correctly reports
        # as `true` for local/Ollama). Ollama has no remote model-list API
        # at all, so this simply steps aside with a neutral, accurate
        # message instead of guessing.
        if current_settings.local or current_settings.llm_provider == "ollama":
            result["error"] = "Provider is Ollama (local mode) -- enter a model slug manually."
            return result

        base_url = authhub_base_url(current_settings)
        api_key = authhub_api_key()
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
