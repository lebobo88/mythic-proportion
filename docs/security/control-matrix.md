# Control Matrix — Mythic Proportion (Phase 2 / §4.9)

Branch: `feat/3d-graphrag`. Maps controls to the threats they mitigate (see
`threat-model.md`) and marks each **enforced now**, **deferred (with owning phase)**, or
**accepted-risk**. Author: `security-reviewer`.

Fresh artifact — no prior control matrix and no conflicting security invariant in
`memory/invariants.md` (no N9 conflict).

## Status legend

- **ENFORCED** — implemented and verified present in current code (file:line cited).
- **DEFERRED** — intentionally not yet built; the owning phase is named.
- **ACCEPTED** — a residual risk consciously accepted under the single-user-local model.

---

## ENFORCED now

| ID | Control | Mitigates (threat) | Evidence in code |
|----|---------|--------------------|------------------|
| C1 | **API keys are env-only.** `AUTHHUB_API_KEY` / `ANTHROPIC_API_KEY` are read straight from `os.environ`, never from `.mythic.toml`, never layered through `Settings`. | TB4 info-disclosure (creds at rest); A4. | `config.py:54-62` (`authhub_api_key`); `config.py` module docstring. |
| C2 | **Keys are never accepted by the UI or `/api/config`.** The `ConfigUpdateRequest` model deliberately has no key field; `POST /api/config` cannot set a key. | TB1 tampering / injection of attacker key. | `web/app.py:55-66` (`ConfigUpdateRequest` docstring + fields), `:332-356`. |
| C3 | **Keys are never logged or echoed.** `GET /api/config` returns only a **boolean** `has_api_key`, never the value. | TB1/TB3 info-disclosure. | `web/app.py:319-330` (`bool(authhub_api_key())`). |
| C4 | **Localhost bind by default.** `serve` binds `127.0.0.1`; the API is not reachable off-box unless the user explicitly overrides `--host`. | TB1 spoofing / remote exposure. | `cli/app.py:270` (`host = "127.0.0.1"`). |
| C5 | **Single-user-local, no auth by design.** No authN/authZ layer; the trust model is machine ownership. (This is a *documented design choice*, not an oversight.) | Scopes TB1 to the local box. | Absence of any auth middleware in `web/app.py` (intentional; see threat-model TB1). |
| C6 | **Provider allowlist.** `POST /api/config` accepts `llm_provider` only from `{authhub, anthropic}` (422 otherwise); `model` must be non-empty. | TB1/TB3 tampering (arbitrary provider redirect). | `web/app.py:40` (`_VALID_PROVIDERS`), `:337-347`. |
| C7 | **Upload path-traversal prevention.** Uploaded filenames are reduced to basename before write; raw originals are stored under a content-hash name. | TB2 path traversal. | `web/app.py:265` (`Path(upload.filename or "upload.bin").name`); `ingest/pipeline.py:179` (`raw/<hash><ext>`). |
| C8 | **Serialized ingest (no stampede / no write race).** Exactly one background worker thread runs `ingest_drop`/`compile_source`/`reindex`; request threads only enqueue. | TB1/TB2 DoS + index/ledger tampering races. | `web/jobs.py` (`IngestWorker`, single daemon thread). |
| C9 | **Fail-safe query path.** `POST /api/query` never 500s; on LLM failure it falls back to retrieval-only and surfaces the error. | TB1 availability. | `web/app.py:196-223`. |
| C10 | **Structured-output constraint on LLM responses.** Compile/answer responses are forced to a strict JSON schema and reparsed; free prose is rejected. | TB2 prompt-injection (format hijack). | `llm/authhub.py:49-64`, `extract_json_object`, `_parse_*_input`. |
| C11 | **`allow_egress` gate exists** (default `False`) as the intended switch for network/LLM egress. | TB3 (partial — governs *whether* to call out, not *what* is sent). | `config.py:34`. |

## DEFERRED (owning phase named)

| ID | Control | Mitigates | Owning phase / owner |
|----|---------|-----------|----------------------|
| D1 | **PII redaction before cloud-LLM egress.** Strip/mask PII & secrets from note/query content before it is sent to AuthHub→DeepSeek. **This is the mitigation for the system's top residual risk (TB3).** | TB3 info-disclosure (unredacted cloud egress) — **HIGH**. | **Phase 6** (privacy layer; `privacy` extra = presidio-analyzer/anonymizer, already declared in `pyproject.toml:35`). Owned by `privacy` subsystem + reviewed here. |
| D2 | **MCP write-authorization + audit log.** Least-privilege authorization for MCP tool writes, plus an append-only audit trail of tool actions and cloud egress. | TB1 repudiation; TB2/TB3 elevation via tool-use; egress accountability. | **Phase 8** (MCP; `mcp` extra = fastmcp, `pyproject.toml:37`). **This control matrix is where §4.15's tool-permission-matrix / guardrail concern for the MCP layer will be assessed when Phase 8 lands — no separate §4.15 security artifact is needed; the least-privilege judgment for the model/tool/memory boundary is recorded here.** |
| D3 | **CORS / CSRF protection on state-changing `/api/*` routes.** Same-origin or CSRF-token guard so a malicious browser page can't drive `POST /api/config`, `/api/upload`, `/api/lint/fix`. | TB1 tampering via DNS-rebinding/CSRF (U3). | Recommend near-term; remediation implemented by `engineer`. Not yet owned by a numbered phase — flag for scheduling. |
| D4 | **Require `https://` for any non-localhost `authhub_base_url`.** Reject plaintext remote gateway URLs. | TB3 MITM / plaintext creds+content. | Small remediation for `engineer`; pairs with D1. |
| D5 | **Upload size/count limits + basic rate limiting.** | TB1/TB2 DoS (disk fill, queue flood). | `engineer`; low priority while localhost-only. |

## ACCEPTED risk (single-user-local model)

| ID | Accepted risk | Rationale | Revisit trigger |
|----|---------------|-----------|-----------------|
| A-1 | **No authentication on the API.** | Deliberate single-user-local design (C5). | If ever bound to a non-loopback interface / shared host. |
| A-2 | **No at-rest encryption** of notes, embeddings, SQLite index, `.mythic.toml`. | Files-first local vault; rely on OS full-disk encryption. | Multi-user machine, or vault synced to shared/cloud storage. |
| A-3 | **Full vault content readable by any localhost caller** (search/page/graph). | Follows from C5. | Non-localhost bind. |
| A-4 | **Unredacted cloud-LLM egress until D1 ships.** | User opts into cloud LLM features knowingly; `allow_egress` default `False`. | **Closes when Phase 6 (D1) ships** — this is the priority item. |

## Supply chain — ongoing

| ID | Control | Status |
|----|---------|--------|
| SC1 | **Supply-chain hardening** (dependency pinning, SBOM generation, `pip-audit`/`npm audit`, third-party parser risk). | **DEFERRED — ongoing.** Baseline posture + regeneration commands in `sbom.md`. Document parsers (Docling/MarkItDown) processing untrusted input (TB2) are the notable ongoing exposure. |

---

## Coverage check against §4.9 named failure modes

- *Unprovable controls* — every ENFORCED control cites file:line evidence.
- *Overbroad permissions* — C5/A-1 make the no-auth choice explicit and bounded to localhost; D2 reserves least-privilege for the MCP write path.
- *Policy/law-violating data handling* — TB3/A-4/D1 make the unredacted-egress exposure explicit and assign it an owner (Phase 6).
- *Untracked third-party/build risks* — SC1 + `sbom.md`.
