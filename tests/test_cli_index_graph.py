"""CLI-level smoke tests for `mythic index-graph` (Phase 3/4 bugfix,
DEFECT 1 -- "extraction is never invoked by any real entry point").

`index-graph` was previously registered `hidden=True` and never called by
any real entry point (`ingest`, the web UI, or `watch`) -- these tests pin
that it is now (a) discoverable in `--help`, and (b) a real, working,
end-to-end command over a vault with actual `raw/` ingested content.
"""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

import mythic_proportion.graph.index as graph_index_module
from mythic_proportion.cli.app import app
from mythic_proportion.graph.extract import COMPLETION_DELIM, FakeExtractionClient
from mythic_proportion.graph.tuples import TUPLE_DELIM

runner = CliRunner()


def _entity_record(name: str, etype: str, desc: str) -> str:
    return f'("entity"{TUPLE_DELIM}{name}{TUPLE_DELIM}{etype}{TUPLE_DELIM}{desc})'


def test_index_graph_is_discoverable_in_help() -> None:
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "index-graph" in result.output


def test_index_graph_end_to_end_over_real_raw_ingested_content(tmp_path: Path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    runner.invoke(app, ["init", str(vault)])

    drop_dir = vault / "drop"
    drop_dir.mkdir(parents=True, exist_ok=True)
    (drop_dir / "note.md").write_text(
        "Ada Lovelace worked with Charles Babbage on the Analytical Engine.", encoding="utf-8"
    )
    ingest_result = runner.invoke(app, ["ingest", str(vault), "--no-compile"])
    assert ingest_result.exit_code == 0

    fixture_response = _entity_record("Ada Lovelace", "PERSON", "a mathematician") + COMPLETION_DELIM

    def _fake_build_extraction_client(settings):  # noqa: ANN001
        return FakeExtractionClient(lambda s, u, i: COMPLETION_DELIM if "MANY entities" in u else fixture_response)

    monkeypatch.setattr(graph_index_module, "build_extraction_client", _fake_build_extraction_client)

    result = runner.invoke(app, ["index-graph", "--vault", str(vault), "--max-gleanings", "0"])
    assert result.exit_code == 0, result.output
    assert "Graph reindexed" in result.output


def test_index_graph_missing_credential_prints_clean_error_and_exits_nonzero(
    tmp_path: Path, monkeypatch
) -> None:
    vault = tmp_path / "vault"
    runner.invoke(app, ["init", str(vault)])
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)

    result = runner.invoke(app, ["index-graph", "--vault", str(vault)])
    assert result.exit_code != 0
    assert "AUTHHUB_API_KEY" in result.output
