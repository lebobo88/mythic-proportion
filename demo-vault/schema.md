# Schema

This vault follows the **Mythic Proportion / LLM-Wiki** page-type contract.
Every wiki page lives under `wiki/<type-plural>/` and begins with YAML
frontmatter followed by Markdown body prose that freely uses `[[wikilinks]]`
to reference other pages by their title (the graph *is* the wikilinks).

## Frontmatter fields (all page types)

| Field         | Type       | Meaning                                              |
|---------------|------------|-------------------------------------------------------|
| `type`        | string     | One of `source`, `entity`, `concept`, `session`.       |
| `source_hash` | string     | SHA-256 of the originating `raw/` file, if any.        |
| `created`     | ISO 8601   | Timestamp the page was first written.                  |
| `updated`     | ISO 8601   | Timestamp of the most recent edit (human or compile).   |
| `tags`        | list[str]  | Free-form tags used for filtering and Obsidian search.  |

## Page types

### `source` (`wiki/sources/`)
A summary of one ingested source document (from `raw/`). Captures what the
document is, its key claims, and links out to the entities/concepts it
introduces or touches.

### `entity` (`wiki/entities/`)
A named, concrete thing referenced across one or more sources: a person,
organization, product, tool, or system. Accumulates facts and links back to
every source page that mentions it.

### `concept` (`wiki/concepts/`)
An abstract idea, pattern, or technique that recurs across sources (e.g. "LLM-Wiki
pattern", "hybrid retrieval"). Synthesizes the idea once and is linked from every
page that touches it, rather than re-explaining it each time.

### `session` (`wiki/sessions/`)
A record of a harness run, conversation, or work session — useful for
harness-aware ingestion of `.fable/` artifacts and `memory/` decisions.

## The `[[wikilink]]` convention

Any page may reference another by writing `[[Page Title]]`. Wikilinks are
resolved by exact page title match (case-insensitive). A wikilink to a page
that does not yet exist is a *dangling* link; later phases (compile, lint)
create stub pages for dangling links or report them so they can be resolved.
