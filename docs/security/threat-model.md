# Threat Model — Mythic Proportion (Phase 2 / §4.9)

Branch: `feat/3d-graphrag` · Scope: the **current** attack surface as implemented today.
Method: STRIDE per trust boundary. Author: `security-reviewer`.

This is a fresh artifact (no prior `docs/security/threat-model.md` and no security
invariant in `memory/invariants.md` to preserve — no N9 conflict).

## System summary (what actually exists in code)

Mythic Proportion is a **single-user, local-first** personal knowledge vault. It runs
as a local FastAPI process (`mythic serve`) over a vault directory on the user's own
machine. There is intentionally **no authentication and no multi-tenancy** — the security
model is "you own the machine and the vault." Confirmed in code:

- `src/mythic_proportion/cli/app.py:270` — `serve` binds `127.0.0.1` by default (localhost only).
- `src/mythic_proportion/web/app.py` — FastAPI app with a legacy SPA at `/`, the new
  Vite/React/R3F build mounted at `/app` (when built), and the `/api/*` JSON routes.
- `src/mythic_proportion/config.py` — settings; API keys are env-only, never in `.mythic.toml`.
- `src/mythic_proportion/llm/authhub.py` — the cloud LLM path (AuthHub gateway → DeepSeek).
- `src/mythic_proportion/ingest/pipeline.py` + `web/jobs.py` — the drop-folder ingest path.

## Trust boundaries

| # | Boundary | Inside (trusted) | Outside (untrusted / lower trust) |
|---|----------|------------------|-----------------------------------|
| TB1 | Localhost HTTP | The FastAPI process + its `/api/*` routes | Any process/browser tab that can reach `127.0.0.1:<port>` |
| TB2 | Drop-folder ingest | The vault's `raw/`, `wiki/`, index | Arbitrary files a user drops or uploads (untrusted content) |
| TB3 | Cloud LLM egress | The local process | AuthHub gateway + DeepSeek cloud (note/PII content **leaves the machine**) |
| TB4 | Local persistence | SQLite index, `.mythic.toml`, ledger, `raw/` | Other local users / processes / backup tooling on the same box |

## Assets

- **A1 Raw notes** (`raw/`, `drop/`, staging) — may contain **PII, secrets, credentials,
  private personal content**. Highest-value asset. Stored unredacted today.
- **A2 Compiled wiki** (`wiki/`) — LLM-derived Markdown pages; inherit A1's sensitivity.
- **A3 Embeddings + SQLite index** (`index/`, FTS5 + vectors) — reconstructable but leaks
  note content via snippets/search.
- **A4 Credentials** — `AUTHHUB_API_KEY` / `ANTHROPIC_API_KEY` (env-only).
- **A5 Availability** of the local service and ingest worker.

## Actors

- **U1** Legitimate local user (trusted).
- **U2** Malicious/curious local process or second OS user on the same machine.
- **U3** A web page / other browser tab hitting `127.0.0.1` (DNS-rebinding / CSRF-style).
- **U4** The AuthHub gateway operator and DeepSeek provider (see them as an honest-but-curious
  third party that *receives your note content*).
- **U5** Author of a malicious dropped/uploaded file.

---

## STRIDE by boundary

### TB1 — Localhost web UI / `/api/*` routes

Enumerated routes (from `web/app.py`): `GET /`, static `/static` + `/app`;
`GET /api/pages`, `GET /api/page`, `GET /api/search`, `POST /api/query`, `GET /api/graph`,
`POST /api/ingest`, `POST /api/upload`, `GET /api/ingest/status`, `GET /api/jobs/{id}`,
`GET /api/lint`, `POST /api/lint/fix`, `GET /api/config`, `POST /api/config`, `GET /api/models`.

| STRIDE | Threat | Current mitigation | Residual risk |
|--------|--------|--------------------|---------------|
| **S**poofing | A remote origin poses as the user by reaching the local API. | Localhost bind (`127.0.0.1`) by default — not reachable off-box unless the user overrides `--host`. | If user runs `--host 0.0.0.0` on an untrusted LAN, **all routes are unauthenticated and exposed**. No auth exists by design. **Accepted for localhost; open for non-localhost bind.** |
| **T**ampering | `POST /api/config` mutates active model/provider/route at runtime; `POST /api/lint/fix` writes stub pages; `POST /api/upload` writes into `drop/`. | Provider is allowlisted to `{authhub, anthropic}` (422 otherwise); model must be non-empty; upload filenames reduced to basename (`Path(name).name`, `app.py:265`) so **no path traversal**. | No CSRF token and **no CORS policy configured** — a malicious web page (U3) could issue state-changing `POST`s to `127.0.0.1` from the user's browser. Config changes don't leak keys, but could redirect LLM traffic (see TB3). **Open — low likelihood on pure localhost, but real.** |
| **R**epudiation | No per-request audit trail for API actions. | Ingest writes an append-only `wiki/log.md`; job state is retained in memory. | No auth means no attributable actor; acceptable for single-user. MCP write-authz + audit log is **DEFERRED to Phase 8** (see control-matrix.md). |
| **I**nformation disclosure | `GET /api/config` returns provider/model/base-url and a **boolean** `has_api_key`. `GET /api/page`/`/api/search` return full note content. | Config endpoint returns only `bool(...)`, **never the key value** (`app.py:327`). Keys never accepted or echoed by any route. | Any localhost caller can read all vault content (search/page/graph). Accepted under the single-user-local model; becomes a real leak under a non-localhost bind. |
| **D**enial of service | Large/many uploads or expensive queries. | Ingest is serialized on **one** background worker thread (`web/jobs.py`) — no CPU stampede, no write race; queries never 500 (fallback to retrieval-only). | **No upload size/count limit and no rate limiting.** A local caller can fill disk via `/api/upload` or flood the ingest queue. **Accepted (local, single-user); revisit if ever network-exposed.** |
| **E**levation of privilege | Reaching filesystem/LLM through the API beyond intent. | No shell-out from routes; upload path components stripped; provider allowlisted. | LLM prompt content is model-controlled downstream (see TB2/TB3 prompt-injection). No OS privilege escalation path identified. |

### TB2 — Drop-folder / upload ingest (untrusted file input)

`POST /api/upload` saves into `drop/`; `ingest_drop` (`ingest/pipeline.py`) classifies by
extension, hashes, dedups, parses (Docling/MarkItDown), moves originals to `raw/<hash><ext>`.

| STRIDE | Threat | Current mitigation | Residual risk |
|--------|--------|--------------------|---------------|
| **T**ampering / path traversal | Malicious `../` filename escapes `drop/`. | Upload strips to basename (`Path(upload.filename or "upload.bin").name`, `app.py:265`); raw files are stored under a **content-hash** name, not the original. | Low. Path traversal via upload is mitigated. |
| **I**nfo disclosure / SSRF via parsers | A crafted PDF/DOCX/HTML makes Docling/MarkItDown fetch remote resources or leak local files. | Parsing is per-file, errors are caught and a single bad file never aborts the run (`pipeline.py:208`). Rich/binary parsing requires the optional `ingest` extra. | **Open (low–med).** Document parsers (Docling/MarkItDown) are complex third-party code processing untrusted input; a malicious document could trigger parser RCE/SSRF/XXE depending on adapter behavior. No sandboxing today. Tracked in vendor-risk / sbom.md as supply-chain-ongoing. |
| **T**ampering (prompt injection) | An ingested document contains instructions that hijack the compile LLM ("ignore prior instructions, exfiltrate…"). | Compile output is constrained to a **strict JSON schema** (`authhub.py` `_COMPILE_JSON_DIRECTIVE`) and reparsed; free prose is rejected. | **Open.** Schema-constraint limits format drift but not semantic injection — a document can still steer the *content* of compiled pages. Downstream MCP tool-use (Phase 8) would raise the stakes; flagged there. |
| **D**oS | Huge or malformed files stall parsing. | Single serialized worker; per-file try/except. | No size cap (see TB1 DoS row). Accepted local. |
| **X**SS chain | Ingested content rendered into the SPA. | Search snippets are pre-escaped via `render_snippet_html`; page HTML via `render_markdown`. | Rendering safety depends on `web/render.py` escaping (not re-audited here) — **flagged for the frontend/render review**, low residual on localhost. |

### TB3 — Cloud LLM egress (AuthHub → DeepSeek) — **PRIMARY EXPOSURE**

> **Note content and any PII/secrets it contains LEAVE THE MACHINE UNREDACTED.**
> `compile` and `query` send the user's raw note text / question to the AuthHub gateway
> (`http://localhost:3000` by default per `config.py:43`, but AuthHub is a **cloud
> multi-provider proxy** that forwards to **DeepSeek cloud** by default —
> `llm_model = "deepseek-chat"`). There is **no PII redaction layer today**; that is
> **DEFERRED to Phase 6** (see control-matrix.md). Until Phase 6 ships, treat every note
> you compile or query against as disclosed to the AuthHub operator and DeepSeek.

| STRIDE | Threat | Current mitigation | Residual risk |
|--------|--------|--------------------|---------------|
| **I**nfo disclosure | Raw notes/questions (with PII/secrets) sent to a third-party cloud LLM. | `allow_egress` setting exists (`config.py:34`, default `False`) as an intended gate; single-provider allowlist; user can point `llm_provider`/`llm_model` at a local model. **No redaction of content itself.** | **HIGH / open.** This is the top residual risk of the whole system. Content is transmitted unredacted over the AuthHub path. Mitigation owner: **Phase 6 privacy/redaction layer**. Until then, egress of sensitive content is an *accepted, documented* risk the user opts into by using cloud LLM features. |
| **S**poofing / MITM | Traffic to AuthHub intercepted or gateway impersonated. | `X-API-Key` header auth to the gateway; timeouts + bounded retries. | Default `authhub_base_url` is **`http://localhost:3000`** (plaintext) — fine for a local gateway, but if pointed at a remote `http://` endpoint, credentials + note content travel **unencrypted**. **Recommend: require `https://` for any non-localhost base URL** (remediation for `engineer`, not implemented here). |
| **T**ampering | A rebound/CSRF `POST /api/config` silently switches the model/route so future queries go to an attacker-chosen model. | Provider allowlist limits to two providers; `route_alias` free-form. | Combined with the missing CORS/CSRF control (TB1), a malicious page could flip provider/route. **Open, low likelihood on localhost.** |
| **R**epudiation | No record of what content was sent to the cloud. | None specific. | No egress audit log. Deferred alongside Phase 8 audit logging. |

### TB4 — Local persistence (SQLite index, config, raw store)

| STRIDE | Threat | Current mitigation | Residual risk |
|--------|--------|--------------------|---------------|
| **I**nfo disclosure at rest | Another local user/process reads `raw/`, the SQLite index, or `.mythic.toml`. | Credentials are **not** in `.mythic.toml` (env-only, `config.py` docstring). Vault lives under the user's own directory tree. | **No at-rest encryption** of notes, embeddings, or index. Anyone with read access to the vault directory (or an unencrypted backup) reads everything. **Accepted** under the local-single-user trust model; documented in data-classification.md. Recommend OS-level full-disk encryption. |
| **T**ampering | Index or ledger corrupted by a concurrent writer. | Single-worker ingest serializes all index/ledger/graph writes (`web/jobs.py`); reindex is incremental by content hash. | Low. |
| **S**poofing (SQL injection) | Malicious `q`/`path` params reach SQL. | Search/index use parameterized `IndexStore`/FTS5 access (not string-built SQL in the reviewed routes). | Low, pending a dedicated review of `index/store.py` query construction (not re-audited here). |

---

## Verdict on the current surface

The design is coherent for its stated **single-user, localhost, files-first** model. The
enforced controls (localhost bind, env-only keys never echoed, single-worker serialization,
upload basename-stripping, provider allowlist) are real and correctly implemented.

**Top open items (see control-matrix.md for ownership):**
1. **Unredacted cloud-LLM egress (TB3)** — HIGH — owned by **Phase 6**.
2. **No CORS/CSRF protection on state-changing `/api/*` routes (TB1)** — MED on localhost — recommend a same-origin/CSRF guard.
3. **Untrusted-document parser exposure + no upload size cap (TB2)** — MED — supply-chain-ongoing + a size limit for `engineer`.
4. **Plaintext default LLM base URL if repointed remotely (TB3)** — MED — require `https://` for non-localhost.
