# Usage

Mythic Proportion exposes seven headline commands: `init`, `ingest`,
`index-graph`, `query`, `lint`, `watch`, `serve` — plus two hidden utility
commands (`reindex`, `ingest-harness`) not part of the public surface.

A working LLM provider is required for `ingest --compile` and `query` — see
"LLM provider configuration" below. Parsing/filing/dedup (`--no-compile`) and
`search` need no LLM.

## `mythic init`

Create (or validate) the vault skeleton at a path.

```bash
mythic init ./my-vault
```

Creates `drop/ raw/ wiki/{sources,entities,concepts,sessions}/ .index/
.vault-meta/ _templates/`, seed files (`schema.md`, `index.md`, `hot.md`), and
a minimal Obsidian config (`.obsidian/app.json`, `.obsidian/graph.json`,
`.obsidian/core-plugins.json`, `.obsidian/plugins/templates/data.json`).
Idempotent — safe to re-run; pass `--force` to overwrite seed files back to
their canonical starting content.

## `mythic ingest`

Parse, dedup, and file everything currently sitting in `<vault>/drop/`.

```bash
mythic ingest ./my-vault
mythic ingest ./my-vault --no-compile   # Phase-2-only behavior: parse+file, skip LLM compile
```

By default (`--compile`, the default), every newly ingested source is also
compiled into wiki pages using the configured LLM provider (AuthHub/DeepSeek
by default, or Anthropic if `MYTHIC_LLM_PROVIDER=anthropic`). A working
provider is required: a missing credential or client failure for a given
source prints a clean, actionable error for that source only — `ingest`
itself still exits 0.

## `mythic index-graph`

Build or refresh the GraphRAG knowledge graph: entity/relationship/claim
extraction from `<vault>/raw/` source documents, hierarchical Leiden
community detection, and community reports, stored in the same SQLite
sidecar the hybrid index uses.

```bash
mythic index-graph --vault ./my-vault
```

This is what populates the `mode=entities`/`mode=both` `/api/graph` data
and the Graph view's Orbital, Strata, and Knowledge Terrain modes with real
community structure. It is not run automatically by `ingest` unless the
Settings "auto-build knowledge graph after ingest" toggle is turned on
(off by default, since extraction spends real LLM calls). Requires the
`[graphrag]` extra:

```bash
pip install 'mythic-proportion[graphrag]'
```

## `mythic query`

Answer a question by retrieving from the hybrid index and (optionally)
synthesizing a cited answer.

```bash
mythic query "how does hybrid retrieval work?" --vault ./my-vault
mythic query "what connects these two topics?" --vault ./my-vault --mode global
```

`--mode` selects the retrieval strategy: `auto` (default, preserves legacy
behavior until the GraphRAG layer has data), `legacy`, `global`, `local`,
`drift`, or `activation` — the GraphRAG community/entity-graph retrieval
modes described in `docs/architecture.md`. Omitting `--mode` (or the
web UI's `POST /api/query` omitting `mode`) always returns the legacy
five-key response shape unconditionally.

LLM synthesis is required: `query` always synthesizes a cited answer via the
configured LLM provider. `--no-llm` is deprecated and now errors with a clear
message rather than degrading to an offline ranked-pages digest — use the
web UI's Search tab, or `mythic reindex` + a direct index query, for pure
offline retrieval.

## `mythic lint`

Vault health check: orphan pages, broken/dangling wikilinks, stale index
rows, and thin/empty pages.

```bash
mythic lint ./my-vault
mythic lint ./my-vault --fix   # auto-create dangling stubs, prune stale index rows, refresh hot.md
```

Exits `0` when clean, `1` when any issue remains. `--fix` never invents
content for orphans/thin pages — only mechanical repairs (stub creation,
index pruning, hot.md refresh) are automatic.

## `mythic watch` (optional)

Watch `<vault>/drop/` in real time and trigger the exact same ingest(+compile)
pipeline `mythic ingest` uses, automatically, as files land.

```bash
mythic watch ./my-vault
mythic watch ./my-vault --settle 2.0 --no-compile
```

Requires the optional `watchdog` dependency:

```bash
pip install 'mythic-proportion[watch]'
```

A debounce ("settle") window (default 1.5s) coalesces a burst of filesystem
events — a file still being copied, or several files dropped together — into
exactly one ingest cycle, so a single drop never double-fires. Foreground
process; press Ctrl-C for a clean shutdown.

## `mythic serve` (optional)

Serve a local web UI over the vault — a drop zone, search, ask, graph, lint,
and settings, all backed by the exact same building blocks the CLI uses.

```bash
mythic serve --vault ./my-vault
mythic serve --vault ./my-vault --host 0.0.0.0 --port 9000 --no-browser
```

Options: `--vault` (defaults to the current directory), `--host` (default
`127.0.0.1`), `--port` (default `8765`), `--no-browser` (skip auto-opening the
URL). Requires the optional `web` extra:

```bash
pip install 'mythic-proportion[web]'
```

Serves two frontends:

- **`http://127.0.0.1:8765/app/`** — the current React + Three.js frontend,
  with seven views (Wiki, Search, Ask, Graph, Ingest, Lint, Settings), a
  Cmd+K command palette, and a four-mode 3D/2D Graph view. Requires a
  one-time frontend build first (`cd web && npm install && npm run build`);
  its output is not committed to the repository, so `/app` 404s until this
  build has been run for the current checkout. See `docs/frontend.md` for
  the full frontend architecture.
- **`http://127.0.0.1:8765/`** — the original vanilla-JS single-page app
  with six tabs (Wiki, Search, Ask, Graph, Ingest, Lint), preserved
  unchanged for parity. Retiring it is deferred, unscheduled future work.

Both frontends talk to the same `/api/*` JSON API; CORS is restricted to a
small allowlist of local origins and state-changing `POST /api/*` routes
carry CSRF protection — see `docs/architecture.md` for the security details.

`fastapi`/`uvicorn` are imported lazily, so the rest of the CLI stays
importable without the `web` extra installed.

## Hidden utility commands

These support the seven headline verbs but aren't part of the public surface
(`hidden=True`, so they don't appear in `--help`):

```bash
mythic reindex --vault ./my-vault
mythic ingest-harness --harness-root /path/to/FABLE-HARNESS --vault ./my-vault
```

See `docs/harness-ingest.md` for the harness-aware ingest recipe.

## LLM provider configuration

`ingest --compile` and `query` require a working, configured LLM provider —
there is no offline/no-LLM fallback anymore. A missing or misconfigured
provider raises `CompileError`/`AnswerError` (a clear, actionable message)
rather than silently degrading.

| Variable | Default | Meaning |
|---|---|---|
| `MYTHIC_LLM_PROVIDER` | `authhub` | `authhub` (default), `anthropic`, or `ollama`. |
| `AUTHHUB_API_KEY` | — | AuthHub gateway credential, sent as the `X-API-Key` header (required for the `authhub` provider). Read directly from the environment, never from `.mythic.toml`. |
| `MYTHIC_AUTHHUB_BASE_URL` (or `AUTHHUB_BASE_URL`) | `http://localhost:3000` | AuthHub gateway base URL. |
| `MYTHIC_LLM_MODEL` | `deepseek-chat` | Model slug sent to whichever provider is active (point this at a Claude model slug if using the `anthropic` provider, or a pulled local model name such as `qwen2.5:7b-instruct` if using `ollama`). |
| `MYTHIC_ROUTE_ALIAS` | — | Optional AuthHub routing hint, forwarded as `route_alias` when set. |
| `ANTHROPIC_API_KEY` | — | Required credential when `MYTHIC_LLM_PROVIDER=anthropic`. |

AuthHub (`pip install 'mythic-proportion[authhub]'`) is an OpenAI-compatible
multi-provider gateway: mythic sends `POST {base_url}/api/v1/ai/chat/completions`
and, since that endpoint has no `tools`/`response_format` option, obtains
structured output via a prompted strict-JSON instruction appended to the
system prompt. Anthropic (`pip install 'mythic-proportion[llm]'`) remains a
selectable alternative provider, using the original tool-use structured
output. A local Ollama provider (`pip install 'mythic-proportion[local]'`,
`MYTHIC_LLM_PROVIDER=ollama`, default model `qwen2.5:7b-instruct`) is also available
for fully private, loopback-only compile/query with no cloud egress; setting
`local: true` enforces the loopback-only egress gate both at config-save
time and at LLM-client-construction time, taking precedence over any other
provider setting.

BM25/hybrid retrieval (`search`, the Search tab) and lint's
dangling-wikilink detection need no LLM and are unaffected — see
`docs/architecture.md` for the full design rationale.
