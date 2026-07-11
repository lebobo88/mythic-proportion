# Mythic Proportion

An **LLM-Wiki second brain** with an auto-ingesting drop folder. Drop any
document, image, or artifact into `vault/drop/`; the system parses it,
preserves the immutable original in `vault/raw/`, and compiles it into a
persistent, self-linking, Obsidian-compatible Markdown knowledge graph —
searchable via a local SQLite hybrid-search sidecar, and optionally kept live
with a real-time watcher.

See `specs/mythic-proportion.html` for the full implementation plan, and
`docs/architecture.md` / `docs/usage.md` / `docs/obsidian.md` for the deeper
docs. All seven build phases (project scaffold, ingestion core, LLM compile,
hybrid index, query & lint, the optional watcher + Obsidian polish, and the
local web UI) are complete.

## 60-second quickstart

```bash
# From the mythic-proportion/ directory:
python -m pip install -e ".[dev]"

# Initialize a vault (creates drop/, raw/, wiki/{sources,entities,concepts,sessions}/,
# .index/, .vault-meta/, _templates/, schema.md, index.md, hot.md, and a
# ready-to-open .obsidian/ config with graph colour groups + templates):
mythic init ./my-vault

# A working LLM provider is required for compile/query (see "LLM provider
# configuration" below) -- set AUTHHUB_API_KEY (default provider, AuthHub)
# or ANTHROPIC_API_KEY (MYTHIC_LLM_PROVIDER=anthropic) first.

# Drop something in, then ingest it (parses, dedups, files it in raw/, and
# compiles it into wiki pages via the configured LLM provider):
cp some-report.pdf ./my-vault/drop/
mythic ingest ./my-vault

# Ask a question (synthesized + cited via the configured LLM provider):
mythic query "what did that report say?" --vault ./my-vault

# Health-check the vault (orphans, broken links, stale index rows):
mythic lint ./my-vault

# Optional: watch drop/ in real time instead of running `ingest` by hand
# (requires: pip install 'mythic-proportion[watch]'):
mythic watch ./my-vault

# Optional: run the local web UI (requires: pip install 'mythic-proportion[web]'):
mythic serve --vault ./my-vault

# List all six commands:
mythic --help
```

Open `./my-vault` directly in Obsidian — see `docs/obsidian.md`.

## Web UI

`mythic serve --vault ./my-vault` starts a local FastAPI + vanilla-JS SPA at
`http://127.0.0.1:8765/` (override with `--host`/`--port`; pass `--no-browser`
to skip auto-opening it). It wraps the exact same building blocks as the CLI
across six tabs:

- **Wiki** — browse pages, rendered Markdown with live wikilinks.
- **Search** — hybrid BM25 + vector search over the vault.
- **Ask** — synthesized, cited question answering.
- **Graph** — the wikilink network as a node/edge graph.
- **Ingest** — drag-and-drop upload into `drop/`, or trigger an ingest cycle
  over files already there.
- **Lint** — vault health check, with a one-click fix action.

Requires the optional `web` extra:

```bash
pip install 'mythic-proportion[web]'
```

## LLM provider configuration

A working LLM provider is **required** for `ingest --compile` and `query` —
there is no offline/no-LLM mode anymore; a missing or misconfigured provider
raises a clear, actionable error instead of silently degrading.

The default provider is **AuthHub**, an OpenAI-compatible multi-provider
gateway that mythic authenticates to with an `AUTHHUB_API_KEY` (sent as
`X-API-Key`) and requests a **DeepSeek** model by default
(`POST {base_url}/api/v1/ai/chat/completions`, structured output via
prompted strict JSON). Install it with:

```bash
pip install 'mythic-proportion[authhub]'
export AUTHHUB_API_KEY=...
```

Relevant environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `MYTHIC_LLM_PROVIDER` | `authhub` | `authhub` or `anthropic`. |
| `AUTHHUB_API_KEY` | — | AuthHub gateway credential (required for the `authhub` provider). |
| `MYTHIC_AUTHHUB_BASE_URL` (or `AUTHHUB_BASE_URL`) | `http://localhost:3000` | AuthHub gateway base URL. |
| `MYTHIC_LLM_MODEL` | `deepseek-chat` | Model slug sent to whichever provider is active. |
| `MYTHIC_ROUTE_ALIAS` | — | Optional AuthHub routing hint. |

**Anthropic (Claude) remains a selectable alternative provider:**

```bash
pip install 'mythic-proportion[llm]'
export MYTHIC_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=...
```

BM25/hybrid retrieval (`search`) and the dangling-wikilink graph stubs in
`lint` require no LLM and keep working exactly as before — it is only
`compile` (used by `ingest`/`watch`) and `query`'s answer synthesis that now
require a configured LLM. See `docs/architecture.md` for the full design
rationale.

## Development

```bash
python -m pytest -q --cov=mythic_proportion
python -m ruff check .
python -m mypy src

# or, all three via the Makefile:
make check
```

## Design ethos

Six simple commands (`init / ingest / query / lint / watch / serve`) on the
surface; a typed, robust pipeline underneath. Parsing/filing/dedup
(`ingest --no-compile`) and search stay dependency-light — hybrid retrieval
gets better with local embeddings — but compiling wiki pages and synthesizing
query answers now require a configured LLM provider (AuthHub/DeepSeek by
default, or Anthropic/Claude as an alternative): a missing credential is
reported as a clear, actionable error rather than a silent stub.
