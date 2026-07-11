# Harness-aware ingest recipe

Mythic Proportion can optionally pull a FABLE-HARNESS run's own knowledge
artifacts — `specs/`, `memory/`, and recent `.fable/` run artifacts — into a
vault's `drop/` and ingest them, so decisions, plans, and run history become
part of your compounding second brain alongside your own documents.

This is **strictly one-way and optional**: it copies *from* a harness root
*into* a vault, on explicit request, and never the other way. Per
CONSTITUTION N8, the harness's own operation never depends on this app
running — nothing in FABLE-HARNESS's own tooling calls into
`mythic_proportion` anywhere.

## What gets pulled in

| Harness path         | Behavior when present                                   | Behavior when absent |
|-----------------------|----------------------------------------------------------|------------------------|
| `<harness_root>/specs/`  | every file copied (flattened, `specs__...` name prefix) | recorded as skipped, not an error |
| `<harness_root>/memory/` | every file copied (flattened, `memory__...` name prefix) | recorded as skipped, not an error |
| `<harness_root>/.fable/` | the `N` most-recently-modified files (default `N=20`), flattened with a `fable__...` name prefix | recorded as skipped, not an error |

Files are **copied**, never moved — the harness's own copies are always left
untouched. Nested paths are flattened with `__` separators (e.g.
`memory/decisions/2026-07-10.md` → `memory__decisions__2026-07-10.md`) since
`drop/` has no subdirectory structure. A file already staged in `drop/` from a
prior harness-ingest run is left alone (not re-copied).

## Two ways to run it

### 1. The hidden CLI command

```bash
mythic ingest-harness --harness-root H:\FABLE-HARNESS --vault ./my-vault
mythic ingest-harness --harness-root H:\FABLE-HARNESS --vault ./my-vault --compile
mythic ingest-harness --harness-root H:\FABLE-HARNESS --vault ./my-vault --fable-limit 50
```

Not one of the five headline verbs, so it's `hidden=True` and doesn't appear
in `mythic --help` — but it's a fully wired, tested command
(`tests/test_harness_ingest.py`).

### 2. The standalone script

```bash
python scripts/ingest_harness.py --harness-root H:\FABLE-HARNESS --vault ./my-vault
```

Equivalent to the CLI command above; useful for a Makefile target or cron job
that doesn't want to depend on the `mythic` console-script entry point being
on `PATH`. See the `Makefile`'s `ingest-harness` target:

```bash
make ingest-harness HARNESS_ROOT=H:\FABLE-HARNESS VAULT=./my-vault
```

## Compile step

Both entry points default `compile=False` — a harness's `specs/`/`memory/`/
`.fable/` tree can be bulky, and bulk-compiling all of it in one pass may not
be what you want. Pass `--compile` (CLI) or `compile=True`
(`harness_ingest.ingest_harness`) to also run the LLM compile step over every
newly ingested harness artifact, or run `mythic ingest --compile` (or
`compile.pipeline.compile_pending`) on the resulting vault afterward to
compile everything that was ingested-but-not-yet-compiled.
