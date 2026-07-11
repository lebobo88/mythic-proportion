#!/usr/bin/env python
"""Standalone convenience wrapper for the harness-aware ingest recipe.

Equivalent to the hidden `mythic ingest-harness` CLI command; provided as a
plain script for anyone who wants to run it without going through the `mythic`
console-script entry point (e.g. from a Makefile target or a cron job). See
docs/harness-ingest.md for the full recipe.

Usage:
    python scripts/ingest_harness.py --harness-root H:\\FABLE-HARNESS --vault ./my-vault
    python scripts/ingest_harness.py --harness-root H:\\FABLE-HARNESS --vault ./my-vault --compile
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running this script directly from a source checkout without having
# installed the package first (`pip install -e .`).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from mythic_proportion.harness_ingest import (  # noqa: E402
    DEFAULT_FABLE_ARTIFACT_LIMIT,
    ingest_harness,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--harness-root", required=True, type=Path, help="Path to the FABLE-HARNESS root."
    )
    parser.add_argument(
        "--vault", required=True, type=Path, help="Vault to ingest into (must already be `mythic init`-ed)."
    )
    parser.add_argument(
        "--fable-limit",
        type=int,
        default=DEFAULT_FABLE_ARTIFACT_LIMIT,
        help="Max number of most-recently-modified .fable/ artifacts to pull in.",
    )
    parser.add_argument(
        "--compile",
        action="store_true",
        help="Also compile newly ingested harness artifacts into wiki pages.",
    )
    args = parser.parse_args(argv)

    collect_report, ingest_report = ingest_harness(
        args.harness_root,
        args.vault,
        fable_artifact_limit=args.fable_limit,
        compile=args.compile,
    )

    print(f"Collected: {len(collect_report.copied)} file(s) from {args.harness_root}")
    if collect_report.skipped_missing:
        print(f"Not found (skipped): {', '.join(collect_report.skipped_missing)}")
    print(f"Ingested: {len(ingest_report.ingested)}")
    print(f"Skipped (duplicates): {len(ingest_report.skipped)}")
    print(f"Errors: {len(ingest_report.errors)}")
    return 1 if ingest_report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
