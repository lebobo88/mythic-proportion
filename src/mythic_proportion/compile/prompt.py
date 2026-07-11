"""Build the schema-grounded compile prompt (Phase 3).

Follows the Sonnet-5 prompting guidance in
``ai_docs/model-routing-and-fable-policy.md``: "find everything" is decoupled
from "filter for importance" into two explicitly labelled steps, rather than
asking the model to do both at once.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from textwrap import dedent

from mythic_proportion.ingest.models import IngestedSource

#: Default cap on how much of a source's parsed Markdown we inline into the
#: prompt, to keep token budget predictable regardless of source size.
DEFAULT_MAX_SOURCE_CHARS = 12_000

_SYSTEM_TEMPLATE = dedent(
    """\
    You are the compile step of Mythic Proportion, an LLM-Wiki "second brain".
    You turn one freshly ingested source into a small set of durable,
    interlinked Markdown wiki pages that accumulate into a growing knowledge
    graph. The graph *is* the [[wikilinks]] between pages — there is no other
    index. Reuse existing pages by title rather than creating near-duplicates,
    and record contradictions with existing pages instead of silently
    overwriting them.

    ## Page-type contract (schema.md)

    {schema_md}

    ## Work in two separate steps

    Step 1 — EXTRACT EVERYTHING. Read the source in full and enumerate every
    entity, concept, and factual claim it contains, exhaustively. Do not judge
    importance yet; do not filter. This step exists purely to make sure
    nothing is missed.

    Step 2 — SELECT & STRUCTURE. From that exhaustive list, decide which
    entities/concepts/claims deserve their own dedicated wiki page (8-15
    pages total is the target range for one source) versus which belong as
    prose/links inside another page. For each page you decide to create:
      - Pick exactly one page_type: source, entity, concept, or session.
      - Check the "existing wiki pages" list below (case-insensitive). If a
        page with a matching title already exists, do NOT create a duplicate
        — instead write a page body that reuses that exact title in a
        [[wikilink]] and, if the new source disagrees with or adds nuance to
        what that page already implies, add an entry to `contradictions`
        describing the discrepancy in one sentence.
      - Write the body in Markdown prose, freely using [[Page Title]]
        wikilinks to every other page (new or existing) that the content
        relates to.
      - Exactly one `source` page should summarize the source itself and
        link out to every entity/concept page you create or reuse for it.

    ## Output contract

    Return your answer ONLY via the `emit_wiki_pages` tool call (never as
    prose). The tool input must be a JSON object of the shape:

    {{
      "pages": [
        {{"page_type": "source|entity|concept|session",
          "title": "<page title>",
          "tags": ["<tag>", ...],
          "body": "<markdown body with [[wikilinks]]>"}},
        ...
      ],
      "contradictions": ["<one-sentence contradiction note>", ...]
    }}
    """
)


@dataclass(frozen=True)
class CompilePrompt:
    """A fully assembled system+user prompt pair for one compile call."""

    system: str
    user: str
    source_hash: str
    existing_titles: tuple[str, ...]


def build_compile_prompt(
    *,
    schema_md: str,
    existing_titles: Sequence[str],
    source: IngestedSource,
    max_source_chars: int = DEFAULT_MAX_SOURCE_CHARS,
) -> CompilePrompt:
    """Assemble the system+user prompt for compiling ``source``.

    ``existing_titles`` is a compact digest of the vault's current pages (a
    stand-in for a full ``index.md`` read) used purely for dedup — the model
    is instructed to reuse a matching title rather than duplicate it.
    """
    system = _SYSTEM_TEMPLATE.format(schema_md=schema_md.strip() or "(no schema.md found)")

    existing_block = (
        "\n".join(f"- {title}" for title in existing_titles)
        if existing_titles
        else "(none yet — this is the first source compiled into this vault)"
    )

    truncated = source.parsed_markdown[:max_source_chars]
    truncated_note = (
        "\n\n[... truncated for length ...]\n" if len(source.parsed_markdown) > max_source_chars else ""
    )

    user = dedent(
        f"""\
        ## Existing wiki pages (for dedup — reuse titles exactly, case-insensitively)

        {existing_block}

        ## Source to compile

        - original_name: {source.original_name}
        - content_hash: {source.content_hash}
        - kind: {source.kind}
        - mime: {source.mime}

        ```markdown
        {truncated}{truncated_note}
        ```
        """
    )

    return CompilePrompt(
        system=system,
        user=user,
        source_hash=source.content_hash,
        existing_titles=tuple(existing_titles),
    )
