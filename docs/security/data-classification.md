# Data Classification & Handling Policy — Mythic Proportion (Phase 2 / §4.9)

Branch: `feat/3d-graphrag`. Defines the classification scheme for the data a personal
vault holds, and each class's handling/retention posture. Author: `security-reviewer`.

Fresh artifact — no prior classification policy and no conflicting invariant in
`memory/invariants.md`. `data-modeler` should tag vault fields against **this** scheme
rather than inventing a competing one; a data model that lacks these tags is the gap to flag.

## Classification scheme

Four sensitivity classes, in increasing order:

| Class | Meaning here |
|-------|--------------|
| **PUBLIC** | Safe to disclose anywhere. |
| **INTERNAL** | Operational/config data; not secret but not for publication. |
| **CONFIDENTIAL** | Personal knowledge content; disclosure harms the user's privacy. |
| **RESTRICTED** | Secrets/credentials and PII; disclosure is a security/privacy incident. |

Because this is a **personal vault**, the working assumption is that user content is
**CONFIDENTIAL by default and may contain RESTRICTED material** (a note can paste an API
key, a password, a medical detail, a third party's PII). The system does not — today —
detect or separate that RESTRICTED material out; **PII redaction is DEFERRED to Phase 6**
(see control-matrix.md D1). Until then, all note-derived data is handled at the higher of
its possible classes.

## The data classes a personal vault holds

| Data | Location (code) | Class | May contain | At rest | Egress today |
|------|-----------------|-------|-------------|---------|--------------|
| **Raw notes / dropped files** | `drop/`, `raw/<hash><ext>`, `.vault-meta/staging/` (`ingest/pipeline.py`) | **CONFIDENTIAL**, potentially **RESTRICTED** | Free text, PII, pasted secrets, private documents | Plaintext files; **no encryption** (accepted A-2) | Sent to cloud LLM on compile **unredacted** (TB3) |
| **Compiled wiki pages** | `wiki/*.md` (`compile_source`) | **CONFIDENTIAL** (inherits raw) | LLM-restructured note content | Plaintext Markdown | Sent as retrieval context on query **unredacted** |
| **Embeddings** | SQLite vector table (`index/store.py`) | **CONFIDENTIAL** | Numeric vectors that encode note semantics (content-recoverable in part) | Plaintext SQLite | Not sent out (local embedder default, `embeddings_backend="local"`, `config.py:33`) |
| **SQLite index (FTS5 + metadata)** | `index/` store | **CONFIDENTIAL** | Full note text for search; snippets | Plaintext SQLite | Snippets returned to any localhost caller |
| **Dedup ledger + op log** | `.vault-meta/ingested.json`, `wiki/log.md` (`ingest/pipeline.py`) | **INTERNAL** | Filenames, content hashes, timestamps | Plaintext | No |
| **Runtime config** | `.mythic.toml`, `Settings` | **INTERNAL** | Provider/model/base-url/route — **never keys** (C1) | Plaintext (safe: no secrets) | Model/provider values shown via `GET /api/config` |
| **API credentials** | `AUTHHUB_API_KEY` / `ANTHROPIC_API_KEY` env vars | **RESTRICTED** | Provider secrets | **Env-only, never on disk in vault** (C1) | Sent as `X-API-Key` to the gateway only |

## Handling rules

- **RESTRICTED credentials** — env-only; never written to `.mythic.toml`, never accepted by
  any route, never logged, only a boolean presence is exposed (C1–C3, `config.py:54`,
  `web/app.py:327`). Enforced today.
- **CONFIDENTIAL content** — stays local at rest, but **is transmitted to the AuthHub→DeepSeek
  cloud unredacted** whenever compile/query use the cloud LLM. This is the central
  data-handling gap; its mitigation (redaction) is **owned by Phase 6**. Users who need to
  keep content off-cloud can run a local model or keep `allow_egress=False` and avoid LLM
  features.
- **INTERNAL config/logs** — non-secret; fine on disk. Do not add secrets to `.mythic.toml`
  (that would violate C1).
- **PII inside notes** — currently **not detected or masked**. Treat every note as if it may
  contain a third party's PII; that carries the usual minimization/lawful-basis expectations
  once redaction (Phase 6) and any future sharing/export features exist.

## Retention posture

- **Raw originals are immutable and retained** under `raw/<content-hash>` (append-only;
  dedup skips re-ingest). There is **no automated deletion/expiry** today.
- **Dedup ledger and `wiki/log.md` are append-only** — they retain a permanent record of
  every ingested filename + hash + timestamp.
- **Deletion is manual** — removing a note means deleting its `raw/`, `wiki/`, staging, and
  reindexing. There is no "forget this note everywhere" operation, and **cloud-side copies
  held by the LLM provider are outside the vault's control** (a reason redaction, D1, matters).
- **Backups** inherit the vault's plaintext, unencrypted nature (A-2) — a vault backup is a
  full CONFIDENTIAL/RESTRICTED disclosure if it leaks.

## Recommendations (for `data-modeler` / `engineer`, not implemented here)

1. Add a per-field/per-page `classification` tag in the data model, defaulting to
   CONFIDENTIAL, so Phase 6 redaction has a hook and export features can respect it.
2. Provide a real delete/forget operation that purges `raw/`, `wiki/`, staging, ledger entry,
   and index rows together.
3. Document (in user-facing docs) that cloud-LLM use transmits note content unredacted until
   Phase 6, and that OS full-disk encryption is the recommended at-rest control.
