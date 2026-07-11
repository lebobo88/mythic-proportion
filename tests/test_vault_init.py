"""Tests for vault initialization (Phase 1)."""

from __future__ import annotations

from pathlib import Path

from mythic_proportion.vault.init import init_vault
from mythic_proportion.vault.layout import (
    INDEX_FILE,
    OBSIDIAN_CONFIG_FILE,
    OBSIDIAN_DIR,
    SCHEMA_FILE,
    is_initialized,
    vault_dirs,
    vault_files,
)


def test_init_vault_creates_every_dir_and_file(tmp_path: Path) -> None:
    init_vault(tmp_path)

    for d in vault_dirs(tmp_path):
        assert d.is_dir(), f"expected directory {d} to exist"
    for f in vault_files(tmp_path):
        assert f.is_file(), f"expected file {f} to exist"


def test_schema_md_documents_all_four_page_types(tmp_path: Path) -> None:
    init_vault(tmp_path)

    schema_text = (tmp_path / SCHEMA_FILE).read_text(encoding="utf-8")
    for page_type in ("### `source`", "### `entity`", "### `concept`", "### `session`"):
        assert page_type in schema_text, f"schema.md missing section for {page_type}"


def test_init_vault_is_idempotent_and_does_not_clobber(tmp_path: Path) -> None:
    init_vault(tmp_path)

    index_path = tmp_path / INDEX_FILE
    custom_content = "# Index\n\nuser-added content that must survive re-init\n"
    index_path.write_text(custom_content, encoding="utf-8")

    # Re-running without force should not raise and should not clobber the file.
    init_vault(tmp_path)
    assert index_path.read_text(encoding="utf-8") == custom_content

    # Re-running with force=True is allowed to overwrite.
    init_vault(tmp_path, force=True)
    assert index_path.read_text(encoding="utf-8") != custom_content


def test_is_initialized_true_after_init(tmp_path: Path) -> None:
    assert not is_initialized(tmp_path)
    init_vault(tmp_path)
    assert is_initialized(tmp_path)


def test_obsidian_config_present(tmp_path: Path) -> None:
    init_vault(tmp_path)
    obsidian_config = tmp_path / OBSIDIAN_DIR / OBSIDIAN_CONFIG_FILE
    assert obsidian_config.is_file()
    assert "graph" in obsidian_config.read_text(encoding="utf-8")
