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

-- ---------------------------------------------------------------------------
-- GraphRAG data layer (Phase 3, specs/ROADMAP-BRIEF.md §6.2). Coexists with
-- the tables above -- nothing here is read/written by the plain hybrid-search
-- path; only `mythic_proportion.graph.*` touches it. `communities` and
-- `community_reports` are created here but stay UNPOPULATED until Phase 4
-- (Leiden clustering + report generation). SQLite foreign keys are declared
-- for documentation/intent only -- this project never issues
-- `PRAGMA foreign_keys = ON`, so deletes are handled explicitly in
-- `graph.store.GraphStore` rather than relied on as DB-enforced cascades.
--
-- Sibling `vec0` virtual tables (`entity_vectors`, `text_unit_vectors`,
-- `report_vectors`) are -- like `vec_pages` above -- created dynamically in
-- `graph.store.ensure_graph_vec_tables` (not here), because their column
-- width depends on the active embedder's `dim` and they only make sense once
-- `sqlite-vec` has loaded successfully.

CREATE TABLE IF NOT EXISTS entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    degree      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(title, type)
);

-- `(source_id, target_id, type)` is the relationship *identity*: the same
-- logical edge extracted from multiple text-units (or re-extracted across
-- re-index passes of a changed page) must merge into one row rather than
-- duplicate, since Phase 4's spreading-activation retrieval weights edges
-- and `entities.degree` counts relationship rows -- see
-- `idx_relationships_identity` below and `GraphStore.upsert_relationship`,
-- which upserts on that identity. `type` is `NOT NULL DEFAULT ''`, so the
-- identity is fully NULL-free and the unique index below applies cleanly.
CREATE TABLE IF NOT EXISTS relationships (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    weight      REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_relationships_source_id ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target_id ON relationships(target_id);
-- Enforces relationship identity on already-created DBs too -- unlike a
-- `UNIQUE(...)` clause inside `CREATE TABLE IF NOT EXISTS`, a separate
-- `CREATE UNIQUE INDEX IF NOT EXISTS` still applies retroactively when this
-- script runs against a DB whose `relationships` table already existed
-- without it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_identity
    ON relationships(source_id, target_id, type);

-- `page_path` deliberately mirrors `pages.page_path` (not a surrogate
-- `page_id`) -- every other table in this schema (page_vectors, pages_fts)
-- already keys off the same vault-relative path, so text_units follows suit
-- for consistency; ties graph provenance straight back to `pages`.
CREATE TABLE IF NOT EXISTS text_units (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_path    TEXT NOT NULL REFERENCES pages(page_path) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    n_tokens     INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(page_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_text_units_page_path ON text_units(page_path);

CREATE TABLE IF NOT EXISTS text_unit_entities (
    text_unit_id INTEGER NOT NULL REFERENCES text_units(id) ON DELETE CASCADE,
    entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (text_unit_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_text_unit_entities_entity_id ON text_unit_entities(entity_id);

CREATE TABLE IF NOT EXISTS claims (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    object_id    INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    type         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'SUSPECTED',
    description  TEXT NOT NULL DEFAULT '',
    period_start TEXT,
    period_end   TEXT,
    text_unit_id INTEGER REFERENCES text_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_claims_subject_id ON claims(subject_id);
CREATE INDEX IF NOT EXISTS idx_claims_text_unit_id ON claims(text_unit_id);

-- Lexical (BM25) index over entity title+description -- one of the two seed
-- sources ("FTS5 BM25 UNION sqlite-vec cosine") for Phase 4's
-- spreading-activation query mode; also reused by LOCAL/DRIFT seed
-- selection. Kept in sync by `graph.store.GraphStore.upsert_entity` /
-- `delete_orphan_entities`, mirroring exactly how `pages_fts` is kept in
-- sync by `IndexStore.upsert_page`/`delete_page` above.
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id UNINDEXED,
    title,
    description,
    tokenize = 'porter unicode61'
);

-- Phase 4 fills these (graspologic hierarchical_leiden + community reports).
CREATE TABLE IF NOT EXISTS communities (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    level          INTEGER NOT NULL,
    cluster        INTEGER NOT NULL,
    parent_cluster INTEGER,
    entity_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS community_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    level        INTEGER NOT NULL,
    cluster      INTEGER NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    summary      TEXT NOT NULL DEFAULT '',
    full_content TEXT NOT NULL DEFAULT '',
    rating       REAL,
    UNIQUE(level, cluster)
);

-- Read-through cache for every extraction LLM call, keyed on
-- sha256(system||user||model) -- see `graph.cache`. This is what makes
-- re-indexing an unchanged vault idempotent and cheap.
CREATE TABLE IF NOT EXISTS llm_cache (
    cache_key TEXT PRIMARY KEY,
    response  TEXT NOT NULL
);
