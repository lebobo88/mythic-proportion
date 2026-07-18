"""Tests for Phase 3 security hardening (Section 6.2(a)): CORS, CSRF
protection on state-changing ``/api/*`` POST routes, and the ``/api/upload``
size cap.

Guarded by ``pytest.importorskip("fastapi")`` exactly like the other web
test modules.
"""

from __future__ import annotations

from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")

from mythic_proportion.vault.init import init_vault  # noqa: E402
from mythic_proportion.web.app import ALLOWED_ORIGINS, CSRF_PROTECTED_PATHS, create_app  # noqa: E402


def _client(vault: Path) -> "fastapi.testclient.TestClient":
    from fastapi.testclient import TestClient

    app = create_app(vault)
    return TestClient(app)


def _seed_vault(tmp_path: Path) -> Path:
    vault = tmp_path / "vault"
    init_vault(vault)
    return vault


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------


def test_cors_allows_a_known_local_origin(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/config", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_cors_does_not_expose_the_response_to_an_unknown_origin(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/config", headers={"Origin": "http://evil.example"})
    # The server still answers (this isn't a request-blocking mechanism --
    # a real browser is what actually withholds the response body from
    # script on a disallowed origin), but no ACAO header is issued, so no
    # browser would ever expose this response to that origin's JS.
    assert "access-control-allow-origin" not in response.headers


def test_cors_preflight_for_a_protected_post_route_rejects_an_unknown_origin(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.options(
        "/api/config",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in response.headers


def test_allowed_origins_cover_both_the_prod_and_dev_local_urls() -> None:
    assert "http://127.0.0.1:8765" in ALLOWED_ORIGINS
    assert "http://localhost:5173" in ALLOWED_ORIGINS


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", sorted(CSRF_PROTECTED_PATHS))
def test_csrf_rejects_a_mismatched_origin_on_every_protected_post_route(tmp_path: Path, path: str) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(path, headers={"Origin": "http://evil.example"})
    assert response.status_code == 403
    assert "CSRF" in response.json()["detail"]


def test_csrf_allows_a_matching_allowed_origin(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config", json={"model": "some-model"}, headers={"Origin": "http://127.0.0.1:8765"}
    )
    assert response.status_code == 200


def test_csrf_falls_back_to_referer_when_origin_is_absent(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/config",
        json={"model": "some-model"},
        headers={"Referer": "http://evil.example/some/page"},
    )
    assert response.status_code == 403


def test_csrf_allows_a_request_with_neither_origin_nor_referer(tmp_path: Path) -> None:
    """Non-browser local callers (curl, scripts, and every existing test in
    this suite's `TestClient` usage) never send an `Origin`/`Referer` header
    at all -- this must keep working exactly as before (this is a browser-
    CSRF defense, not a general auth boundary; see the docstring on
    `_csrf_protection` in `app.py`)."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post("/api/config", json={"model": "some-model"})
    assert response.status_code == 200


def test_csrf_never_applies_to_get_requests(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.get("/api/config", headers={"Origin": "http://evil.example"})
    assert response.status_code == 200


def test_csrf_never_applies_to_an_unprotected_post_route(tmp_path: Path) -> None:
    """`/api/query` is a POST route but isn't in `CSRF_PROTECTED_PATHS` --
    it's a read (synthesis over existing data), not a state-changing action,
    so it's deliberately excluded (matches Section 6.2(a)'s exact route
    list)."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/query", json={"question": "anything"}, headers={"Origin": "http://evil.example"}
    )
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Upload size cap
# ---------------------------------------------------------------------------


def test_upload_within_the_cap_succeeds(tmp_path: Path) -> None:
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files={"files": ("small.md", b"# Small note\n\nJust a few bytes.", "text/markdown")},
    )
    assert response.status_code == 200


def test_upload_exceeding_the_cap_is_rejected(tmp_path: Path, monkeypatch) -> None:
    from mythic_proportion.web import app as web_app_module

    monkeypatch.setattr(web_app_module, "MAX_UPLOAD_BYTES", 10)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files={"files": ("big.md", b"this content is longer than ten bytes", "text/markdown")},
    )
    assert response.status_code == 413

    # Nothing was written to drop/ -- a rejected upload must not partially land.
    drop_dir = vault / "drop"
    assert not (drop_dir / "big.md").exists()


def test_upload_content_length_precheck_rejects_before_reading_files(tmp_path: Path, monkeypatch) -> None:
    from mythic_proportion.web import app as web_app_module

    monkeypatch.setattr(web_app_module, "MAX_UPLOAD_BYTES", 10)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files={"files": ("big.md", b"this content is longer than ten bytes", "text/markdown")},
        headers={"Content-Length": "99999"},
    )
    assert response.status_code == 413


# ---------------------------------------------------------------------------
# Codex J-001/J-002 remediation cycle (CODE_REVIEW shadow findings)
# ---------------------------------------------------------------------------


def test_upload_streaming_middleware_rejects_a_large_body_even_with_no_content_length_precheck_help(
    tmp_path: Path, monkeypatch
) -> None:
    """J-001: the streaming ASGI middleware must itself enforce the cap by
    counting actual bytes as they arrive -- not rely on the (spoofable/
    absent) `Content-Length` header the in-handler pre-check uses. Proven
    here by an UNDERSTATED `Content-Length` (the opposite direction from
    the existing overstated-header test above): the header claims the body
    is tiny, so the handler's own header pre-check would let it through,
    but the actual streamed bytes exceed the cap regardless."""
    from mythic_proportion.web import app as web_app_module

    monkeypatch.setattr(web_app_module, "MAX_UPLOAD_BYTES", 10)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files={"files": ("big.md", b"this content is longer than ten bytes", "text/markdown")},
        headers={"Content-Length": "1"},
    )
    assert response.status_code == 413
    assert not (vault / "drop" / "big.md").exists()


def test_upload_multi_file_atomicity_no_partial_files_persist_when_a_later_file_trips_the_cap(
    tmp_path: Path, monkeypatch
) -> None:
    """J-002: a multi-file upload where an early file alone is under the
    cap but a later file in the SAME request pushes the aggregate over must
    leave `drop/` completely untouched -- not persist the early file while
    rejecting the request, which a later `/api/ingest` call could silently
    pick up despite the upload having been rejected."""
    from mythic_proportion.web import app as web_app_module

    monkeypatch.setattr(web_app_module, "MAX_UPLOAD_BYTES", 20)
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files=[
            ("files", ("first.md", b"short", "text/markdown")),
            ("files", ("second.md", b"this one pushes the total well past the cap", "text/markdown")),
        ],
    )
    assert response.status_code == 413

    drop_dir = vault / "drop"
    assert not (drop_dir / "first.md").exists()
    assert not (drop_dir / "second.md").exists()
    assert not drop_dir.exists() or not list(drop_dir.iterdir())


def test_upload_atomicity_holds_even_when_the_cap_is_never_involved(tmp_path: Path, monkeypatch) -> None:
    """J-002, isolated from J-001: the size cap (well above both files here)
    is never in play -- a failure moving the SECOND staged file into
    `drop/` (an unrelated I/O error, not a cap trip) must still leave the
    FIRST file un-persisted, proving atomicity holds for any failure
    partway through, not just the cap-rejection case."""
    from mythic_proportion.web import app as web_app_module

    real_move = web_app_module.shutil.move
    call_count = {"n": 0}

    def _flaky_move(src: str, dst: str) -> str:
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise OSError("simulated disk error moving the second staged file")
        return real_move(src, dst)

    monkeypatch.setattr(web_app_module.shutil, "move", _flaky_move)

    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files=[
            ("files", ("one.md", b"first note", "text/markdown")),
            ("files", ("two.md", b"second note", "text/markdown")),
        ],
    )
    assert response.status_code == 500

    drop_dir = vault / "drop"
    assert not (drop_dir / "one.md").exists(), (
        "the first file was persisted even though the request ultimately failed"
    )


def test_upload_multi_file_success_moves_every_file_into_drop(tmp_path: Path) -> None:
    """Sanity check alongside the atomicity fix: a normal, within-cap
    multi-file upload still lands every file in `drop/` as before."""
    vault = _seed_vault(tmp_path)
    client = _client(vault)

    response = client.post(
        "/api/upload",
        files=[
            ("files", ("one.md", b"first note", "text/markdown")),
            ("files", ("two.md", b"second note", "text/markdown")),
        ],
    )
    assert response.status_code == 200
    data = response.json()
    assert set(data["saved"]) == {"one.md", "two.md"}
    drop_dir = vault / "drop"
    assert (drop_dir / "one.md").read_bytes() == b"first note"
    assert (drop_dir / "two.md").read_bytes() == b"second note"
