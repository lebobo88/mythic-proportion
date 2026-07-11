"""Tests for the Phase 6 Obsidian polish: graph.json, core-plugins.json, and
``_templates/`` frontmatter templates.

Deliberately does not touch/duplicate ``test_vault_init.py`` (Phase 1) -- this
file only asserts what Phase 6 *adds*.
"""

from __future__ import annotations

import json
from pathlib import Path

from mythic_proportion.vault.init import init_vault
from mythic_proportion.vault.layout import (
    OBSIDIAN_CORE_PLUGINS_FILE,
    OBSIDIAN_DIR,
    OBSIDIAN_GRAPH_FILE,
    TEMPLATES_DIR,
)


def test_graph_json_is_valid_and_has_colour_groups_per_page_type(tmp_path: Path) -> None:
    init_vault(tmp_path)
    graph_path = tmp_path / OBSIDIAN_DIR / OBSIDIAN_GRAPH_FILE
    assert graph_path.is_file()

    data = json.loads(graph_path.read_text(encoding="utf-8"))
    assert "colorGroups" in data
    queries = {group["query"] for group in data["colorGroups"]}
    assert queries == {
        "path:wiki/sources",
        "path:wiki/entities",
        "path:wiki/concepts",
        "path:wiki/sessions",
    }
    for group in data["colorGroups"]:
        assert "rgb" in group["color"]


def test_core_plugins_json_is_valid_and_enables_templates_and_graph(tmp_path: Path) -> None:
    init_vault(tmp_path)
    core_plugins_path = tmp_path / OBSIDIAN_DIR / OBSIDIAN_CORE_PLUGINS_FILE
    assert core_plugins_path.is_file()

    data = json.loads(core_plugins_path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert "templates" in data
    assert "graph" in data
    assert "backlink" in data


def test_templates_plugin_points_at_templates_dir(tmp_path: Path) -> None:
    init_vault(tmp_path)
    plugin_data_path = tmp_path / OBSIDIAN_DIR / "plugins" / "templates" / "data.json"
    assert plugin_data_path.is_file()

    data = json.loads(plugin_data_path.read_text(encoding="utf-8"))
    assert data["folder"] == TEMPLATES_DIR


def test_templates_dir_has_one_frontmatter_template_per_page_type(tmp_path: Path) -> None:
    init_vault(tmp_path)
    templates_dir = tmp_path / TEMPLATES_DIR
    assert templates_dir.is_dir()

    for page_type, filename in (
        ("source", "source.md"),
        ("entity", "entity.md"),
        ("concept", "concept.md"),
        ("session", "session.md"),
    ):
        template_path = templates_dir / filename
        assert template_path.is_file(), f"missing template for {page_type}"
        text = template_path.read_text(encoding="utf-8")
        assert text.startswith("---")
        assert f"type: {page_type}" in text
        assert "{{title}}" in text


def test_app_json_still_contains_graph_key_for_backward_compat(tmp_path: Path) -> None:
    """Phase 1 invariant: app.json keeps its "graph" key even though the
    native ``graph.json`` (Phase 6) is now the file Obsidian actually reads."""
    init_vault(tmp_path)
    from mythic_proportion.vault.layout import OBSIDIAN_CONFIG_FILE

    app_json_path = tmp_path / OBSIDIAN_DIR / OBSIDIAN_CONFIG_FILE
    data = json.loads(app_json_path.read_text(encoding="utf-8"))
    assert "graph" in data
    assert "colorGroups" in data["graph"]


def test_vault_opens_cleanly_all_obsidian_json_files_parse(tmp_path: Path) -> None:
    """Structural "opens cleanly" smoke test: every .obsidian/*.json (and
    nested plugin config) is valid JSON with no config errors."""
    init_vault(tmp_path)
    obsidian_dir = tmp_path / OBSIDIAN_DIR
    json_files = list(obsidian_dir.rglob("*.json"))
    assert len(json_files) >= 3
    for path in json_files:
        json.loads(path.read_text(encoding="utf-8"))  # raises on invalid JSON
