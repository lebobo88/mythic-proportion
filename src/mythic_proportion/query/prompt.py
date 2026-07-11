"""Build the query-answer prompt (Phase 5).

Mirrors ``compile/prompt.py``'s shape: a small, frozen, fully-assembled
system+user prompt pair, built from the hot-cache and the retrieved pages so
callers (real client, fake client, or the CLI) never have to re-derive the
wording themselves.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from textwrap import dedent

from mythic_proportion.index.store import SearchHit

#: Default cap on how much of any one retrieved page's body we inline into
#: the prompt, to keep token budget predictable regardless of page size.
DEFAULT_MAX_BODY_CHARS = 2_000

_SYSTEM_TEMPLATE = dedent(
    """\
    You are the query step of Mythic Proportion, an LLM-Wiki "second brain".
    Answer the user's question using ONLY the vault context supplied below
    (the recent-context cache and the retrieved pages) -- never invent facts
    that aren't grounded in that context. Cite every page you draw on by
    writing its exact title as a [[wikilink]], e.g. [[Page Title]]; each
    citation must exactly match one of the retrieved page titles listed
    below. If the supplied context does not contain enough information to
    answer the question, say so plainly rather than guessing.

    Return your answer ONLY via the `emit_answer` tool call (never as prose).
    """
)


@dataclass(frozen=True)
class AnswerPrompt:
    """A fully assembled system+user prompt pair for one query-answer call."""

    system: str
    user: str
    question: str
    hit_titles: tuple[str, ...]


def build_answer_prompt(
    *,
    question: str,
    hot_md: str,
    hits: Sequence[SearchHit],
    body_by_path: dict[str, str],
    max_body_chars: int = DEFAULT_MAX_BODY_CHARS,
) -> AnswerPrompt:
    """Assemble the system+user prompt for answering ``question``."""
    pages_block = (
        "\n\n".join(
            f"### [[{hit.title}]] (`{hit.page_path}`)\n\n"
            f"{body_by_path.get(hit.page_path, '')[:max_body_chars]}"
            for hit in hits
        )
        or "(no pages retrieved)"
    )

    user = dedent(
        f"""\
        ## Recent-context cache (hot.md)

        {hot_md.strip() or "(empty)"}

        ## Retrieved pages

        {pages_block}

        ## Question

        {question}
        """
    )

    return AnswerPrompt(
        system=_SYSTEM_TEMPLATE,
        user=user,
        question=question,
        hit_titles=tuple(hit.title for hit in hits),
    )
