"""Phase 6 regression guard: the base install (none of `[privacy]`,
`[embeddings]`, `[local]` installed) must still import cleanly and run
BM25-only search.

Run in a genuinely fresh subprocess with ``presidio_analyzer``,
``presidio_anonymizer``, ``torch``, ``transformers``, and ``fastembed``
sentinel-blocked in ``sys.modules`` *before* anything in
``mythic_proportion`` is imported -- the standard "set the module name to
``None`` in ``sys.modules``" trick, which makes Python's import machinery
raise ``ImportError`` immediately on any attempted ``import`` of that name,
even though the real packages are actually installed in this dev
environment (for the other Phase 6 tests that exercise them for real). This
proves the laziness claim in every touched module's docstring, rather than
just asserting "importing the top-level package doesn't raise" (which
wouldn't catch an accidental module-scope ``import torch`` buried three
calls deep).
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

_BLOCKED_MODULES = ("presidio_analyzer", "presidio_anonymizer", "torch", "transformers", "fastembed")


def test_base_install_imports_and_bm25_search_works_without_any_optional_extra(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    script = textwrap.dedent(
        f"""
        import sys
        for _mod in {_BLOCKED_MODULES!r}:
            sys.modules[_mod] = None  # sentinel -> ImportError on any `import _mod`

        from mythic_proportion.config import Settings
        from mythic_proportion.compile.models import WikiPage
        from mythic_proportion.compile.writer import write_page
        from mythic_proportion.index.embeddings import HashEmbedder, get_embedder
        from mythic_proportion.index.retrieve import hybrid_search
        from mythic_proportion.index.store import IndexStore
        from mythic_proportion.llm.ollama import is_ollama_reachable
        from mythic_proportion.privacy.redact import (
            RedactionUnavailableError,
            get_redactor,
            is_privacy_extra_installed,
        )
        from mythic_proportion.vault.init import init_vault
        import mythic_proportion.cli.app  # the whole CLI must stay importable too

        vault = {str(vault)!r}
        init_vault(vault)
        write_page(
            vault,
            WikiPage.new(
                page_type="concept",
                title="Zero Dep",
                body="No optional extras installed -- BM25-only search must still work.",
            ),
        )

        settings = Settings(vault_path=vault)

        # privacy: importing/calling this never raises ImportError (the
        # laziness claim this whole test exists to prove) -- but per the
        # fail-closed contract, redaction_enabled=True (the default) with no
        # [privacy] extra installed is a hard refusal, not a silent
        # pass-through: get_redactor raises RedactionUnavailableError rather
        # than returning None.
        assert is_privacy_extra_installed() is False
        try:
            get_redactor(settings)
            raise SystemExit("expected RedactionUnavailableError, got no exception")
        except RedactionUnavailableError:
            pass
        # Explicit opt-out is the only way to get a pass-through None back.
        assert get_redactor(Settings(vault_path=vault, redaction_enabled=False)) is None

        # embeddings: "auto" (the new default) degrades to HashEmbedder when
        # fastembed isn't installed -- never raises, never silently no-ops.
        embedder = get_embedder(settings)
        assert isinstance(embedder, HashEmbedder), type(embedder)

        # local: reachability probe never raises even without httpx-adjacent
        # extras misconfigured; base install still has httpx as a dev dep
        # here, so just confirm the call itself doesn't blow up.
        is_ollama_reachable(timeout=0.01)

        # BM25-only search actually works end to end.
        with IndexStore(vault, embedder, use_vec=False) as store:
            store.reindex(vault)
            hits = hybrid_search(store, "zero dep bm25 search", k=5)
        assert hits, "expected BM25 to find the seeded page"

        print("BASE_INSTALL_OK")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parents[1]),
        timeout=60,
    )
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "BASE_INSTALL_OK" in result.stdout
