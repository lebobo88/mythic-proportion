"""Tests for the runtime LLM provider/model configuration surface (``GET``/
``POST /api/config`` and ``GET /api/models``).

Guarded by ``pytest.importorskip("fastapi")`` exactly like ``test_web.py``.
No live network is used: the AuthHub "list models" HTTP call is mocked via
``monkeypatch.setattr("httpx.get", ...)``, and ``authhub_api_key`` is
controlled via environment variables/monkeypatch.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

fastapi = pytest.importorskip("fastapi")

from mythic_proportion.compile.writer import write_page  # noqa: E402
from mythic_proportion.compile.models import WikiPage  # noqa: E402
from mythic_proportion.index.embeddings import HashEmbedder  # noqa: E402
from mythic_proportion.index.store import IndexStore  # noqa: E402
from mythic_proportion.vault.init import init_vault  # noqa: E402
from mythic_proportion.web.app import create_app  # noqa: E402


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    write_page(
        vault,
        WikiPage.new(page_type="concept", title="Seed Page", body="Seed body text."),
    )
    with IndexStore(vault, HashEmbedder(dim=32), use_vec=False) as store:
        store.reindex(vault)
    return vault


def _client(vault: Path) -> "fastapi.testclient.TestClient":
    from fastapi.testclient import TestClient

    app = create_app(vault)
    return TestClient(app)


def test_get_config_returns_current_model_without_leaking_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "secret-key-value")
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/config")
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "authhub"
    assert data["model"] == "deepseek-chat"
    assert data["has_api_key"] is True
    assert "secret-key-value" not in response.text
    assert "api_key" not in data
    assert "key" not in data


def test_get_config_reports_no_api_key(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json()["has_api_key"] is False


def test_post_config_updates_model_and_takes_effect_at_runtime(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "secret-key-value")
    vault = _seed_vault(tmp_path)
    from mythic_proportion.web import app as web_app_module

    app = create_app(vault)
    assert app.state.settings.llm_model == "deepseek-chat"

    from fastapi.testclient import TestClient

    client = TestClient(app)
    response = client.post("/api/config", json={"model": "deepseek-v4-flash"})
    assert response.status_code == 200
    data = response.json()
    assert data["model"] == "deepseek-v4-flash"
    assert data["provider"] == "authhub"

    # The change is visible on app.state.settings immediately -- no restart.
    assert app.state.settings.llm_model == "deepseek-v4-flash"

    # A subsequent GET reflects the update too.
    response2 = client.get("/api/config")
    assert response2.json()["model"] == "deepseek-v4-flash"
    del web_app_module  # imported only to document where app.state lives


def test_post_config_updates_provider(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"provider": "anthropic"})
    assert response.status_code == 200
    assert response.json()["provider"] == "anthropic"


def test_post_config_rejects_invalid_provider(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"provider": "not-a-real-provider"})
    assert response.status_code == 422


def test_post_config_rejects_empty_model(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"model": "   "})
    assert response.status_code == 422


def test_post_config_never_accepts_an_api_key_field(tmp_path: Path) -> None:
    """Even if a client sends an ``api_key``/``key`` field, it's silently
    ignored by pydantic (extra fields aren't declared on the request model)
    -- the key stays env-only."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"model": "deepseek-chat", "api_key": "sneaky"})
    assert response.status_code == 200
    assert "sneaky" not in response.text


def test_get_models_success_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "secret-key-value")

    class _FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {"data": [{"id": "deepseek-chat"}, {"id": "gpt-5.4"}]}

    def _fake_get(url: str, headers: dict[str, str], timeout: float) -> _FakeResponse:
        assert headers["X-API-Key"] == "secret-key-value"
        assert url.endswith("/api/v1/ai/models")
        return _FakeResponse()

    monkeypatch.setattr("httpx.get", _fake_get)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/models")
    assert response.status_code == 200
    data = response.json()
    assert data["models"] == ["deepseek-chat", "gpt-5.4"]
    assert data["current"] == "deepseek-chat"
    assert data["provider"] == "authhub"
    assert "error" not in data


def test_get_models_failure_path_returns_200_with_empty_list(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUTHHUB_API_KEY", "secret-key-value")

    def _fake_get(url: str, headers: dict[str, str], timeout: float) -> Any:
        raise ConnectionError("gateway unreachable")

    monkeypatch.setattr("httpx.get", _fake_get)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/models")
    assert response.status_code == 200
    data = response.json()
    assert data["models"] == []
    assert "error" in data
    assert "gateway unreachable" in data["error"]


# --------------------------------------------------------------------------
# Phase 6: local / redaction / ollama config surface
# --------------------------------------------------------------------------


def test_get_config_exposes_phase6_defaults(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    data = client.get("/api/config").json()
    assert data["local"] is False
    assert data["redaction_enabled"] is True
    assert data["ollama_base_url"] == "http://localhost:11434"
    assert data["ollama_model"] == "qwen2.5:7b-instruct"
    assert data["embeddings_backend"] == "auto"
    # Bugfix DEFECT 1 addition: off by default (real LLM-cost concern).
    assert data["auto_build_graph"] is False


def test_post_config_updates_auto_build_graph_toggle(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"auto_build_graph": True})
    assert response.status_code == 200
    data = response.json()
    assert data["auto_build_graph"] is True

    # And back off -- omitting the field on a later request leaves it
    # untouched (matches every other Phase 6 toggle's contract).
    response = client.post("/api/config", json={"model": "some-other-model"})
    assert response.json()["auto_build_graph"] is True


def test_post_config_updates_local_and_redaction_flags(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"local": True, "redaction_enabled": False})
    assert response.status_code == 200
    data = response.json()
    assert data["local"] is True
    assert data["redaction_enabled"] is False
    # `local: true` never needs a cloud credential -- has_api_key reports True.
    assert data["has_api_key"] is True


def test_post_config_updates_ollama_provider_and_model(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config", json={"provider": "ollama", "ollama_model": "qwen2.5:7b-instruct", "ollama_base_url": "http://localhost:11434"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "ollama"
    assert data["ollama_model"] == "qwen2.5:7b-instruct"


def test_post_config_rejects_empty_ollama_model(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"ollama_model": "   "})
    assert response.status_code == 422


def test_post_config_rejects_non_loopback_ollama_base_url_under_local_true(tmp_path: Path) -> None:
    """Closes a prior review finding: `local: true` with a remote
    `ollama_base_url` must be rejected at config-set time, not silently
    accepted (which would let a local-mode vault egress prompts off-host)."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config", json={"local": True, "ollama_base_url": "http://evil.example.com:11434"}
    )
    assert response.status_code == 422
    assert "loopback" in response.json()["detail"]

    # The rejected update must not have been applied.
    current = client.get("/api/config").json()
    assert current["local"] is False
    assert current["ollama_base_url"] == "http://localhost:11434"


def test_post_config_rejects_non_loopback_ollama_base_url_under_provider_ollama_without_local(
    tmp_path: Path,
) -> None:
    """Retry fix (closes a second prior review finding): the original check
    only validated loopback-ness when ``local`` was true, so
    ``provider="ollama", local=False`` could persist a non-loopback
    ``ollama_base_url`` -- e.g. `compile.pipeline`/`query.engine`'s
    `_default_client` factories route to Ollama whenever
    ``settings.local or settings.llm_provider == "ollama"``, so this
    combination was never a real network-egress bypass (the client's own
    constructor still enforces loopback), but it left a stale, invalid
    ``ollama_base_url`` sitting in config -- exactly the invariant this
    config-time check exists to close. Now validated whenever *either*
    ``local`` or ``llm_provider`` resolves to Ollama."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config",
        json={"provider": "ollama", "ollama_base_url": "http://evil.example.com:11434"},
    )
    assert response.status_code == 422
    assert "loopback" in response.json()["detail"]

    # The rejected update must not have been applied.
    current = client.get("/api/config").json()
    assert current["provider"] != "ollama" or current["ollama_base_url"] == "http://localhost:11434"
    assert current["ollama_base_url"] == "http://localhost:11434"


def test_post_config_rejects_switching_provider_to_ollama_with_an_already_remote_url(tmp_path: Path) -> None:
    """Counterpart of the `local=True` "already remote" case above, for
    `provider="ollama"`: validation is against the *effective* post-update
    state, not just fields present in this specific request body."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    # First: only stage a remote ollama_base_url (provider left at its
    # default, not "ollama" yet -- allowed).
    r1 = client.post("/api/config", json={"ollama_base_url": "http://remote-ollama.example.com:11434"})
    assert r1.status_code == 200

    # Then: switching provider to "ollama" with that URL already in effect
    # must fail.
    r2 = client.post("/api/config", json={"provider": "ollama"})
    assert r2.status_code == 422
    assert "loopback" in r2.json()["detail"]
    assert client.get("/api/config").json()["provider"] != "ollama"


def test_post_config_rejects_switching_local_true_to_an_already_remote_url(tmp_path: Path) -> None:
    """Setting `local: true` while an already-stored `ollama_base_url` is
    remote (set in an earlier, separate request) must also be rejected --
    the check is against the *effective* post-update state, not just fields
    present in the current request body."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    # First: only stage a remote ollama_base_url (local left False --
    # allowed, since `local` isn't true yet).
    r1 = client.post("/api/config", json={"ollama_base_url": "http://remote-ollama.example.com:11434"})
    assert r1.status_code == 200

    # Then: flipping `local` to True with that URL already in effect must fail.
    r2 = client.post("/api/config", json={"local": True})
    assert r2.status_code == 422
    assert "loopback" in r2.json()["detail"]
    assert client.get("/api/config").json()["local"] is False


def test_post_config_accepts_local_true_with_loopback_url(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config", json={"local": True, "ollama_base_url": "http://127.0.0.1:11434"}
    )
    assert response.status_code == 200
    assert response.json()["local"] is True


def test_get_models_without_api_key_falls_back_to_empty_list(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AUTHHUB_API_KEY", raising=False)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/models")
    assert response.status_code == 200
    data = response.json()
    assert data["models"] == []
    assert "AUTHHUB_API_KEY" in data["error"]
