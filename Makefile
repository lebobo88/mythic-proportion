# Mythic Proportion -- CI-style local validation (Phase 6).
#
# Windows note: this Makefile targets a GNU-make-on-Windows / Git-Bash-style
# shell where `python` resolves; if you don't have `make` available, run the
# three commands under `check:` directly (see docs/usage.md).

.PHONY: check lint typecheck test ingest-harness

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
