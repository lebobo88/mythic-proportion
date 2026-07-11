"""Pydantic-settings configuration for Mythic Proportion.

Settings are resolved from (in increasing priority):
1. Defaults defined below.
2. A ``.mythic.toml`` file, if present, located at the vault root.
3. Environment variables prefixed ``MYTHIC_`` (e.g. ``MYTHIC_MODEL``).

The AuthHub gateway's API key is a deliberate exception to the ``MYTHIC_``
prefix: it is read straight from the ``AUTHHUB_API_KEY`` environment
variable (see :func:`authhub_api_key`), mirroring how ``ANTHROPIC_API_KEY``
is read directly by the Anthropic clients rather than being routed through
``Settings`` -- credentials are kept out of ``.mythic.toml``/committed config
entirely, env-only.
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for a single Mythic Proportion vault."""

    model_config = SettingsConfigDict(env_prefix="MYTHIC_", extra="ignore")

    vault_path: Path
    model: str = "claude-sonnet-5"
    embeddings_backend: str = "local"
    allow_egress: bool = False

    #: Which LLM provider ``compile``/``query`` route through: ``"authhub"``
    #: (default -- an OpenAI-compatible multi-provider gateway) or
    #: ``"anthropic"`` (the original direct-to-Claude client).
    llm_provider: str = "authhub"
    #: Base URL of the AuthHub gateway. Overridable at the process level via
    #: the (non-``MYTHIC_``-prefixed) ``AUTHHUB_BASE_URL`` env var -- see
    #: :func:`authhub_base_url`.
    authhub_base_url: str = "http://localhost:3000"
    #: The model slug sent to whichever provider is active. Defaults to a
    #: DeepSeek model served through AuthHub; override with
    #: ``MYTHIC_LLM_MODEL`` (or point ``llm_provider`` at ``"anthropic"`` and
    #: set this to a Claude model slug instead).
    llm_model: str = "deepseek-chat"
    #: Optional AuthHub routing hint, forwarded as ``route_alias`` in the
    #: request body only when non-empty.
    route_alias: str | None = None


def authhub_api_key() -> str | None:
    """The AuthHub gateway API key, read from the environment (not ``.mythic.toml``).

    Deliberately NOT ``MYTHIC_``-prefixed and NOT layered through
    :class:`Settings` -- this is a credential, not a config value, so it is
    read fresh from ``os.environ`` at client-build time, exactly like
    ``ANTHROPIC_API_KEY`` is for the Anthropic clients.
    """
    return os.environ.get("AUTHHUB_API_KEY")


def authhub_base_url(settings: Settings) -> str:
    """``settings.authhub_base_url``, overridable by the ``AUTHHUB_BASE_URL`` env var."""
    return os.environ.get("AUTHHUB_BASE_URL") or settings.authhub_base_url


def _load_toml_overrides(vault_path: Path) -> dict[str, Any]:
    """Read ``<vault_path>/.mythic.toml`` if it exists, else return {}."""
    toml_path = vault_path / ".mythic.toml"
    if not toml_path.is_file():
        return {}
    with toml_path.open("rb") as f:
        return tomllib.load(f)


def load_settings(vault_path: Path) -> Settings:
    """Build a :class:`Settings` for the given vault, layering TOML then env vars.

    Environment variables (``MYTHIC_*``) always take precedence over the
    ``.mythic.toml`` file, which in turn takes precedence over the defaults.
    """
    vault_path = Path(vault_path)
    overrides = _load_toml_overrides(vault_path)
    overrides.setdefault("vault_path", vault_path)
    return Settings(**overrides)
