"""Local web UI for Mythic Proportion (Phase 7).

This subpackage is entirely optional: importing it (or ``mythic_proportion``
itself) never requires ``fastapi``/``uvicorn`` to be installed. Only
:func:`mythic_proportion.web.app.create_app` (and the CLI's ``serve`` command,
which lazy-imports it) touch those optional dependencies, and only when
actually called -- see ``pip install 'mythic-proportion[web]'``.
"""

from __future__ import annotations
