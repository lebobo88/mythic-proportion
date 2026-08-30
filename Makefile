# Mythic Proportion -- CI-style local validation (Phase 6).
#
# Windows note: this Makefile targets a GNU-make-on-Windows / Git-Bash-style
# shell where `python` resolves; if you don't have `make` available, run the
# three commands under `check:` directly (see docs/usage.md).

.PHONY: check lint typecheck test ingest-harness dev prod

check: lint typecheck test

lint:
	python -m ruff check .

typecheck:
	python -m mypy src

test:
	python -m pytest -q --cov=mythic_proportion

# Optional harness-aware ingest recipe (see docs/harness-ingest.md).
# Usage: make ingest-harness HARNESS_ROOT=../.. VAULT=./my-vault
ingest-harness:
	python scripts/ingest_harness.py --harness-root "$(HARNESS_ROOT)" --vault "$(VAULT)"

# ---------------------------------------------------------------------------
# Launchers (see scripts/dev.ps1 and scripts/prod.ps1 for the full options).
#
#   make dev   -- Vite HMR on :5173 + FastAPI on :8766 over ./dev-vault
#   make prod  -- built assets + FastAPI on :8765 over ./my-vault
#
# Both are safe to run at the same time: different ports, different vaults.
# ---------------------------------------------------------------------------

dev:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1

prod:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prod.ps1
