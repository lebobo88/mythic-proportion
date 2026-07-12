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
    #: ``"auto"`` (default, Phase 6) resolves to the real local model
    #: (``bge-small-en-v1.5`` via the optional ``fastembed`` ``[embeddings]``
    #: extra) when installed, falling back to the zero-dependency
    #: :class:`~mythic_proportion.index.embeddings.HashEmbedder` when it
    #: isn't -- see :func:`mythic_proportion.index.embeddings.get_embedder`.
    #: Explicit ``"local"`` always means :class:`HashEmbedder` (unchanged
    #: pre-Phase-6 behavior); explicit ``"fastembed"`` always means the real
    #: model (raising nothing -- it also degrades to :class:`HashEmbedder` if
    #: the extra isn't installed); ``"none"``/``"off"``/``"disabled"`` means
    #: BM25-only.
    embeddings_backend: str = "auto"
    #: Phase 6: whether the cloud-provider branches (``llm_provider in
    #: {"anthropic", "authhub"}``) of the provider selector may construct a
    #: non-localhost client at all, once a required credential is present.
    #: Defaults to ``True`` -- preserving this app's pre-existing behavior of
    #: reaching a cloud LLM provider by default (it is not a local-only app
    #: by default; :attr:`local` is the explicit opt-in for that). Set this
    #: to ``False`` to make the cloud branches fail closed with an
    #: actionable :class:`~mythic_proportion.query.client.AnswerError` /
    #: :class:`~mythic_proportion.compile.models.CompileError` instead of
    #: ever constructing a cloud client -- see
    #: :func:`effective_allow_egress` and ADR-0005 S4 for the precedence
    #: rule against :attr:`local`.
    allow_egress: bool = True

    #: Which LLM provider ``compile``/``query`` route through: ``"authhub"``
    #: (default -- an OpenAI-compatible multi-provider gateway),
    #: ``"anthropic"`` (the original direct-to-Claude client), or
    #: ``"ollama"`` (Phase 6 -- a fully-local model via a local Ollama
    #: daemon; see :mod:`mythic_proportion.llm.ollama`). Ignored (forced to
    #: ``"ollama"``) whenever :attr:`local` is ``True``.
    llm_provider: str = "authhub"
    #: Phase 6 per-vault privacy flag: when ``True``, compile/query/graph
    #: extraction route **entirely** through the local Ollama provider and
    #: NEVER touch any cloud endpoint, regardless of :attr:`llm_provider`.
    local: bool = False
    #: Base URL of the local Ollama daemon, used only when :attr:`local` is
    #: ``True`` or :attr:`llm_provider` is ``"ollama"``.
    ollama_base_url: str = "http://localhost:11434"
    #: Model slug requested from Ollama. Defaults to Qwen2.5-7B-Instruct, the
    #: recommended structured-output-friendly local model (see
    #: :mod:`mythic_proportion.llm.ollama`).
    ollama_model: str = "qwen2.5:7b-instruct"
    #: Phase 6: redact PII locally (via :mod:`mythic_proportion.privacy.redact`)
    #: before any prompt reaches the configured LLM provider, then rehydrate
    #: PII back into the response. Defaults to ``True`` -- privacy is the
    #: default posture for a personal second brain. Silently has no effect
    #: (degrades to no-op passthrough) when the optional ``[privacy]`` extra
    #: isn't installed -- see
    #: :func:`mythic_proportion.privacy.redact.get_redactor`.
    redaction_enabled: bool = True
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


def effective_allow_egress(settings: Settings) -> bool:
    """The single derived egress control at the cloud-provider trust boundary.

    ``effective_allow_egress = allow_egress AND NOT local`` (ADR-0005 S4):
    ``local: true`` always wins and forces this to ``False`` regardless of
    the stored ``allow_egress`` value (the local-mode provider selection in
    :func:`mythic_proportion.query.engine._default_client` and its siblings
    never consults this at all -- ``local: true`` routes to Ollama
    unconditionally and never reaches a cloud-branch call site). On a
    ``local: false`` vault this resolves to the stored ``allow_egress``
    value unchanged, which is what the cloud-provider branches
    (``llm_provider in {"anthropic", "authhub"}``) gate their outbound call
    on, once a required credential is present (see those call sites' own
    docstrings for why the credential check runs first).
    """
    return settings.allow_egress and not settings.local


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
