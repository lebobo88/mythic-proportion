# Supply-Chain / SBOM Notes — Mythic Proportion (Phase 2 / §4.9)

Branch: `feat/3d-graphrag`. Enumerates top-level dependencies, records the current
known-risk posture, and documents how to regenerate a full machine-readable SBOM. This is a
**notes/targets** artifact — the generated SBOM file itself is a build-pipeline output
(`ops-author`/CI), not committed here. Author: `security-reviewer`.

Fresh artifact — no prior SBOM note, no conflicting invariant.

## Frontend — top-level npm dependencies (`web/package.json`)

### Runtime `dependencies`

| Package | Declared range | Role |
|---------|----------------|------|
| `react` | ^18.3.1 | UI runtime |
| `react-dom` | ^18.3.1 | DOM renderer |
| `three` | ^0.169.0 | 3D engine (GraphRAG visualization) |
| `@react-three/fiber` | ^8.17.10 | React renderer for three.js |
| `@react-three/drei` | ^9.114.3 | R3F helpers/abstractions |
| `@radix-ui/react-dialog` | ^1.1.19 | Accessible dialog primitive |
| `@radix-ui/react-tooltip` | ^1.2.12 | Accessible tooltip primitive |
| `cmdk` | ^1.1.1 | Command-palette component |
| `clsx` | ^2.1.1 | className helper |
| `culori` | ^4.0.2 | Color manipulation |

### `devDependencies` (build/test only — not shipped in the static bundle)

| Package | Declared range | Role |
|---------|----------------|------|
| `vite` | ^5.4.10 | Build tool / dev server |
| `@vitejs/plugin-react` | ^4.3.3 | React plugin for Vite |
| `typescript` | ^5.6.3 | Type checker / `tsc -b` |
| `vitest` | ^4.1.10 | Test runner |
| `jsdom` | ^25.0.1 | DOM env for tests |
| `@testing-library/react` | ^16.3.2 | Component test utils |
| `@testing-library/jest-dom` | ^6.9.1 | **Test-mock/matcher dep** (jest-dom matchers) |
| `@testing-library/user-event` | ^14.6.1 | User-interaction test utils |
| `@types/react` | ^18.3.12 | Types |
| `@types/react-dom` | ^18.3.1 | Types |
| `@types/node` | ^22.20.1 | Types |
| `@types/culori` | ^4.0.1 | Types |

## Backend — Python dependencies (`pyproject.toml`)

### Base `dependencies`

| Package | Declared | Role |
|---------|----------|------|
| `typer` | >=0.12 | CLI framework |
| `pydantic` | >=2 | Models/validation |
| `pydantic-settings` | >=2 | `Settings` layering (config.py) |
| `rich` | (unpinned) | Terminal output |

### Optional-dependency extras

| Extra | Packages | Purpose | Risk note |
|-------|----------|---------|-----------|
| `ingest` | `docling`, `markitdown` | Parse dropped PDFs/DOCX/HTML/images | **Highest supply-chain attention** — these parse **untrusted input** (threat-model TB2). |
| `embeddings` | `fastembed` | Local embeddings | Local; moderate transitive surface (onnx/tokenizers). |
| `llm` | `anthropic>=0.40` | Direct Anthropic client | Network egress path. |
| `authhub` | `httpx` | AuthHub gateway client (cloud LLM) | Network egress path (TB3). |
| `watch` | `watchdog` | Drop-folder watching | Local FS events. |
| `web` | `fastapi`, `uvicorn` | Local web UI / API | Localhost HTTP surface (TB1). |
| `dev` | `pytest`, `pytest-cov`, `ruff`, `mypy`, `httpx` | Test/lint/type | Dev-only. |
| `graphrag` | `graspologic` | Graph algorithms (Phase 0 decl.) | Lazy-imported; not yet wired. |
| `privacy` | `presidio-analyzer`, `presidio-anonymizer` | **Phase 6 PII redaction** (D1) | Declared, not yet wired — the intended mitigation for the top risk. |
| `local` | `httpx` | Local-model client path | Local egress. |
| `mcp` | `fastmcp` | **Phase 8 MCP tools** (D2) | Declared, not yet wired. |
| `agents` | `pydantic-ai` | Agent orchestration | Declared, not yet wired. |

## Current known-risk posture

- **No known-vulnerable pins as of writing** — but this has **not been machine-verified**; no
  `pip-audit`/`npm audit` output is committed yet. Establishing that baseline is the first
  supply-chain task (control-matrix.md SC1, ongoing).
- **Version ranges, not exact pins.** npm uses caret ranges; Python uses `>=` floors (`rich`
  is entirely unpinned). There is **no lockfile committed for reproducibility review** in this
  artifact's scope — recommend committing `package-lock.json` and a pinned Python constraints
  file so the SBOM is deterministic and SLSA provenance is meaningful.
- **Highest-risk component: the untrusted-document parsers** (`docling`, `markitdown` and their
  transitive deps). They process attacker-supplyable files (TB2) with no sandbox. Prioritize
  these in any audit and keep them current.
- **Egress components** (`httpx`, `anthropic`, `fastapi`/`uvicorn`) are the network surface;
  keep patched.

## How to regenerate a full machine-readable SBOM

Run from the repo root. These are the target commands the build pipeline (`ops-author`/CI)
should wire; output formats are CycloneDX / SPDX per NTIA minimum-elements guidance.

**Frontend (npm, CycloneDX):**
```
cd web
npm ci                                   # deterministic install from lockfile
npm sbom --sbom-format cyclonedx > ../sbom-web.cdx.json
npm audit --audit-level=moderate         # known-vuln scan
# alt richer tool: npx @cyclonedx/cyclonedx-npm --output-file ../sbom-web.cdx.json
```

**Backend (Python):**
```
pip install pip-audit cyclonedx-bom
pip-audit                                # known-vuln scan against installed env
# CycloneDX from the environment:
cyclonedx-py environment -o sbom-py.cdx.json
# or straight from the project metadata:
cyclonedx-py pyproject pyproject.toml -o sbom-py-project.cdx.json
```

**Provenance / build-integrity targets (not yet implemented):**
- **SLSA target: Build Level 2+** — build the web bundle and Python wheel in CI with a
  provenance attestation (e.g. GitHub Actions + SLSA generator) so the artifact's origin is
  verifiable. Currently there is no attested build; treat published artifacts as
  provenance-unknown until CI provenance exists.
- **Format targets: CycloneDX 1.5+ (or SPDX 2.3)** for both SBOMs, regenerated on every
  release and diffed for newly-introduced or newly-vulnerable components.
- **Commit lockfiles** (`web/package-lock.json`, a pinned Python constraints/lock) so SBOM
  regeneration is reproducible.

Ownership: SBOM *generation + attestation wiring* is `ops-author`/CI; the *requirement,
format, and risk interpretation* above are set here (§4.9).
