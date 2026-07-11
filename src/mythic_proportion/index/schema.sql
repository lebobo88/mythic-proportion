-- Core relational schema for the hybrid-search sidecar (Phase 4).
--
-- Applied on every `IndexStore.open()` via `executescript`, so every
-- statement here must be idempotent (`IF NOT EXISTS`). The FTS5 virtual
-- table is a plain (non "external content") table: `page_path` is stored as
-- an UNINDEXED column purely so we can join search hits back to `pages`
-- without needing to keep an FTS rowid in sync with a separate content
-- table's rowid -- fewer moving parts, at the (irrelevant, for a personal
-- vault-sized corpus) cost of duplicating body text on disk.
--
-- Vector storage has two forms, chosen at runtime by `store.py`:
--   * `page_vectors` -- always created; the pure-Python-cosine fallback
--     store, and also kept as a redundant durable copy even when sqlite-vec
--     is available (cheap, and means switching backends never loses data).
--   * `vec_pages` -- a `vec0` virtual table, created dynamically (not here,
--     because its column width depends on the active embedder's `dim`) only
--     when the `sqlite-vec` extension loads successfully. See
--     `IndexStore._sync_embedder_meta`.

CREATE TABLE IF NOT EXISTS pages (
    page_path    TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    page_type    TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated      TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    page_path UNINDEXED,
    title,
    body,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS page_vectors (
    page_path TEXT PRIMARY KEY REFERENCES pages(page_path) ON DELETE CASCADE,
    dim       INTEGER NOT NULL,
    vector    BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
