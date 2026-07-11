"""Dependency-free Markdown -> HTML rendering with ``[[wikilink]]`` resolution (Phase 7).

Used by the web UI's ``GET /api/page`` endpoint to turn a page's raw Markdown
body into safe HTML for the reading pane. Two properties are load-bearing:

* **No XSS from page bodies.** Every character of user/LLM-authored content is
  passed through :func:`html.escape` before any HTML tag is emitted around
  it -- page bodies can never inject markup, scripts, or attributes.
* **Wikilinks become clickable anchors.** ``[[Title]]`` and ``[[Title|Alias]]``
  resolve (case-insensitively) against a caller-supplied ``title_to_path``
  map into ``/#/page?path=<url-encoded path>`` anchors. A link to a title with
  no known page still renders (as a ``wikilink dangling`` styled span with no
  ``href``) rather than breaking the rest of the page.

This is intentionally a small, hand-written renderer (headings, paragraphs,
blockquotes, fenced code blocks, unordered/ordered lists, inline
code/bold/italic/Markdown links) rather than a pulled-in dependency, per the
"self-contained / offline, keep it simple" constraint on this phase.
"""

from __future__ import annotations

import html
import re
import uuid
from urllib.parse import quote

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")

_FENCE_RE = re.compile(r"^```(\w*)\s*$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_UL_RE = re.compile(r"^\s*[-*]\s+(.*)$")
_OL_RE = re.compile(r"^\s*\d+\.\s+(.*)$")
_QUOTE_RE = re.compile(r"^>\s?(.*)$")


def _extract_wikilinks(text: str, title_to_path: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Replace every ``[[wikilink]]`` in ``text`` with a unique placeholder token.

    Returns the placeholder-substituted text plus a ``{placeholder: html}``
    map to splice back in *after* the surrounding text has been HTML-escaped
    and had other inline Markdown applied -- this is what lets wikilink
    aliases be safely escaped exactly once, with no risk of the rest of the
    inline pipeline mangling the anchor markup itself.
    """
    replacements: dict[str, str] = {}

    def _sub(match: re.Match[str]) -> str:
        target = match.group(1).strip()
        alias = (match.group(2) or "").strip() or target
        safe_alias = html.escape(alias)
        path = title_to_path.get(target.lower())
        if path is None:
            anchor = f'<span class="wikilink dangling" title="page not found: {html.escape(target)}">{safe_alias}</span>'
        else:
            href = f"/#/page?path={quote(path)}"
            anchor = f'<a class="wikilink" href="{href}">{safe_alias}</a>'
        token = f"\x00WIKILINK-{uuid.uuid4().hex}\x00"
        replacements[token] = anchor
        return token

    return _WIKILINK_RE.sub(_sub, text), replacements


def _render_inline(text: str, title_to_path: dict[str, str]) -> str:
    """Render one line/span of inline Markdown to safe HTML.

    Wikilinks are protected behind opaque placeholder tokens (see
    :func:`_extract_wikilinks`) *before* escaping, so the alias text is
    escaped exactly once by the outer :func:`html.escape` call below; the
    remaining Markdown constructs (code/bold/italic/links) are then matched
    against the escaped text, which is safe because none of the punctuation
    they key on (`` ` ``, ``*``, ``[``, ``]``, ``(``, ``)``) is touched by
    ``html.escape``.
    """
    protected, wikilinks = _extract_wikilinks(text, title_to_path)
    escaped = html.escape(protected)
    escaped = _INLINE_CODE_RE.sub(lambda m: f"<code>{m.group(1)}</code>", escaped)
    escaped = _BOLD_RE.sub(lambda m: f"<strong>{m.group(1)}</strong>", escaped)
    escaped = _ITALIC_RE.sub(lambda m: f"<em>{m.group(1)}</em>", escaped)
    escaped = _MD_LINK_RE.sub(
        lambda m: f'<a href="{html.escape(m.group(2), quote=True)}" rel="noopener">{m.group(1)}</a>',
        escaped,
    )
    for token, anchor in wikilinks.items():
        escaped = escaped.replace(token, anchor)
    return escaped


def render_snippet_html(snippet: str) -> str:
    """Render an FTS5 ``snippet()`` result (``<mark>``/``</mark>``-delimited) safely.

    Mirrors the escape-then-splice-back-in technique
    :func:`_render_inline`/:func:`_extract_wikilinks` use for ``[[wikilinks]]``:
    the entire string is HTML-escaped first (so any hostile content inside a
    matched term can never inject markup), then exactly the two literal
    ``<mark>``/``</mark>`` tokens the FTS5 query itself inserted are
    unescaped back to real tags. Nothing else in the snippet is ever treated
    as markup, so this is safe even though the underlying page body/query
    terms are untrusted. The Search/Ask views' client-side ``renderSnippet``
    in ``app.js`` applies the identical technique for snippets rendered
    directly in the browser without a round trip through this function.
    """
    escaped = html.escape(snippet)
    return escaped.replace("&lt;mark&gt;", "<mark>").replace("&lt;/mark&gt;", "</mark>")


def render_markdown(body: str, title_to_path: dict[str, str] | None = None) -> str:
    """Render a page's Markdown ``body`` to an HTML fragment.

    ``title_to_path`` maps a lowercased page title to its vault-relative
    ``wiki/...`` path, used to resolve ``[[wikilinks]]``; pass ``{}`` (or
    leave it ``None``) to render every wikilink as an unresolved/dangling
    span (useful when the caller has no page index handy).
    """
    title_to_path = title_to_path or {}
    lines = body.splitlines()
    html_parts: list[str] = []

    paragraph_buffer: list[str] = []
    list_buffer: list[str] = []
    list_kind: str | None = None  # "ul" | "ol"
    quote_buffer: list[str] = []
    in_code_block = False
    code_lang = ""
    code_buffer: list[str] = []

    def flush_paragraph() -> None:
        if paragraph_buffer:
            text = " ".join(paragraph_buffer)
            html_parts.append(f"<p>{_render_inline(text, title_to_path)}</p>")
            paragraph_buffer.clear()

    def flush_list() -> None:
        nonlocal list_kind
        if list_buffer:
            tag = list_kind or "ul"
            items = "".join(f"<li>{_render_inline(item, title_to_path)}</li>" for item in list_buffer)
            html_parts.append(f"<{tag}>{items}</{tag}>")
            list_buffer.clear()
        list_kind = None

    def flush_quote() -> None:
        if quote_buffer:
            text = " ".join(quote_buffer)
            html_parts.append(f"<blockquote>{_render_inline(text, title_to_path)}</blockquote>")
            quote_buffer.clear()

    for line in lines:
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            if in_code_block:
                code_html = html.escape("\n".join(code_buffer))
                lang_class = f' class="language-{html.escape(code_lang)}"' if code_lang else ""
                html_parts.append(f"<pre><code{lang_class}>{code_html}</code></pre>")
                code_buffer.clear()
                in_code_block = False
                code_lang = ""
            else:
                flush_paragraph()
                flush_list()
                flush_quote()
                in_code_block = True
                code_lang = fence_match.group(1)
            continue

        if in_code_block:
            code_buffer.append(line)
            continue

        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            flush_list()
            flush_quote()
            continue

        heading_match = _HEADING_RE.match(stripped)
        if heading_match:
            flush_paragraph()
            flush_list()
            flush_quote()
            level = len(heading_match.group(1))
            html_parts.append(f"<h{level}>{_render_inline(heading_match.group(2), title_to_path)}</h{level}>")
            continue

        quote_match = _QUOTE_RE.match(stripped)
        if quote_match:
            flush_paragraph()
            flush_list()
            quote_buffer.append(quote_match.group(1))
            continue
        flush_quote()

        ol_match = _OL_RE.match(line)
        if ol_match:
            flush_paragraph()
            if list_kind == "ul":
                flush_list()
            list_kind = "ol"
            list_buffer.append(ol_match.group(1))
            continue

        ul_match = _UL_RE.match(line)
        if ul_match:
            flush_paragraph()
            if list_kind == "ol":
                flush_list()
            list_kind = "ul"
            list_buffer.append(ul_match.group(1))
            continue
        flush_list()

        paragraph_buffer.append(stripped)

    flush_paragraph()
    flush_list()
    flush_quote()
    if code_buffer:
        code_html = html.escape("\n".join(code_buffer))
        html_parts.append(f"<pre><code>{code_html}</code></pre>")

    return "\n".join(html_parts)
