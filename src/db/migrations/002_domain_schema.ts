import type { Migration } from './index'

// Column comments record the semantic type that SQLite's five affinities
// cannot express (see CLAUDE.md "SQLite Conventions"). Keep the `up` string
// starting with a statement keyword, not a comment: Database.mutationCounter
// classifies writes by their leading keyword.
//
// `tags` holds categories, merchants, locations, journeys and plain tags, told
// apart by `kind`; per-kind data lives in the `*_details` side tables. Names
// are unique among the live tags of one kind and parent, synonyms included,
// but only the repository checks that: there is no unique index, since two
// devices creating the same name offline must both survive the sync (the
// duplicates are shown, and merged by hand).
//
// `images` holds the pictures icons show (docs/plans/2026-10-28-icons-design.md
// §3). A row never changes after it is written: a new picture is a new row,
// and the same picture is the same row on every device (the id is derived
// from the content).
export const migration: Migration = {
  version: 2,
  up: `
    CREATE TABLE images (
      id              TEXT PRIMARY KEY,                                  -- UUIDv5 of the content's SHA-256
      media_type      TEXT NOT NULL CHECK (media_type IN ('image/webp', 'image/svg+xml')),
      content         TEXT NOT NULL,                                     -- base64 for WebP, the cleaned markup for SVG
      width           INTEGER,                                           -- pixels; NULL = unknown (an SVG without a size)
      height          INTEGER,                                           -- pixels; NULL = unknown
      source          TEXT CHECK (source IS NULL OR json_valid(source)), -- JSON object: the Text tab's settings for a word; NULL for an upload
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE tags (
      id              TEXT PRIMARY KEY,                                  -- short id (12 base-62 characters)
      kind            TEXT NOT NULL CHECK (kind IN ('category', 'merchant', 'location', 'journey', 'tag')),
      name            TEXT NOT NULL,
      parent_id       TEXT REFERENCES tags(id) ON DELETE RESTRICT,       -- short id of a tag of the same kind (repository-checked); NULL = top level
      moved_at_utc    TEXT NOT NULL,                                     -- ISO 8601 UTC instant: when parent_id was last set by the user
      description     TEXT,
      synonyms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms)), -- JSON array of extra names
      retired_names   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retired_names)), -- JSON array of names that no longer find this tag through a tag merged into it
      colour          TEXT,                                              -- NULL = inherited from the parent
      icon            TEXT CHECK (icon IS NULL OR json_valid(icon)),     -- JSON object: the icon (src/icons/types.ts); NULL = inherited from the parent
      merged_into_id  TEXT REFERENCES tags(id) ON DELETE RESTRICT,       -- short id of the tag this one was merged into (set with deleted_at_utc); NULL = not merged
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT,                                              -- ISO 8601 UTC instant; NULL = live
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
    CREATE INDEX idx_tags_parent ON tags(parent_id);

    -- Side tables: what only one kind of tag has, keyed by the tag's id.
    CREATE TABLE location_details (
      tag_id          TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a location tag
      address         TEXT,
      latitude        REAL,                                              -- WGS84 degrees
      longitude       REAL,                                              -- WGS84 degrees
      merchant_id     TEXT REFERENCES tags(id) ON DELETE RESTRICT,       -- short id of a merchant tag (repository-checked); NULL = none
      radius_metres   INTEGER NOT NULL DEFAULT 10 CHECK (radius_metres > 0), -- whole metres around the position that count as this place
      auto_match      INTEGER NOT NULL DEFAULT 1 CHECK (auto_match IN (0, 1)), -- boolean: a transaction paid here gets this location by itself
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE merchant_details (
      tag_id              TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a merchant tag
      default_category_id TEXT REFERENCES tags(id) ON DELETE RESTRICT,   -- short id of a category tag (repository-checked); NULL = none
      auto_match          INTEGER NOT NULL DEFAULT 1 CHECK (auto_match IN (0, 1)), -- boolean: an imported line (statement, receipt) naming it gets this merchant by itself
      created_at_utc      TEXT NOT NULL,                                 -- ISO 8601 UTC instant
      updated_at_utc      TEXT NOT NULL,                                 -- ISO 8601 UTC instant
      deleted_at_utc      TEXT                                           -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE journey_details (
      tag_id          TEXT PRIMARY KEY REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a journey tag
      start_date      TEXT,                                              -- 'YYYY-MM-DD' typed by the user; NULL = derived from the journey's transactions
      end_date        TEXT,                                              -- 'YYYY-MM-DD' typed by the user; NULL = derived from the journey's transactions
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE account_groupings (
      id              TEXT PRIMARY KEY,                                  -- short id
      name            TEXT NOT NULL,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL CHECK (json_valid(icon)),            -- JSON object: the icon (src/icons/types.ts)
      sort_order      INTEGER NOT NULL DEFAULT 0,                        -- position among the groups, ascending; ties by name
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE accounts (
      id              TEXT PRIMARY KEY,                                  -- short id
      name            TEXT NOT NULL,
      currency        TEXT NOT NULL,                                     -- money currency of balance_* (ISO 4217 or custom)
      balance_value   INTEGER NOT NULL,                                  -- money: unscaled value
      balance_scale   INTEGER NOT NULL,                                  -- money: decimal places
      is_cash         INTEGER NOT NULL DEFAULT 0 CHECK (is_cash IN (0, 1)), -- boolean: 1 = cash (money in hand, e.g. a wallet)
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), -- JSON array of plain-tag ids (short ids of tags with kind 'tag')
      location_id     TEXT REFERENCES tags(id) ON DELETE RESTRICT,       -- short id of a location tag; NULL = none
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL CHECK (json_valid(icon)),            -- JSON object: the icon (src/icons/types.ts)
      grouping_id     TEXT REFERENCES account_groupings(id) ON DELETE RESTRICT, -- short id; NULL = not in a group
      sort_order      INTEGER NOT NULL DEFAULT 0,                        -- position within its group (or among ungrouped accounts), ascending; ties by name
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    -- The reference library: rates as each provider publishes them. Device-local
    -- (not synced): it can always be downloaded again.
    CREATE TABLE exchange_rates (
      id              TEXT PRIMARY KEY,                                  -- UUIDv5 of (date, base_currency, provider): one row per key
      date            TEXT NOT NULL,                                     -- 'YYYY-MM-DD' calendar date
      base_currency   TEXT NOT NULL,
      rates           TEXT NOT NULL CHECK (json_valid(rates)),           -- JSON object: currency -> rate
      provider        TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );
    CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(date, base_currency);

    -- The rate the app uses for a day and a currency pair: resolved from the
    -- library, or the user's override (provider 'manual'). Synced.
    CREATE TABLE applied_rates (
      id              TEXT PRIMARY KEY,                                  -- UUIDv5 of (date, currency_a, currency_b): one row per key
      date            TEXT NOT NULL,                                     -- 'YYYY-MM-DD' the day the rate applies to
      currency_a      TEXT NOT NULL,                                     -- the pair in alphabetical order
      currency_b      TEXT NOT NULL,
      rate            REAL,                                              -- units of currency_b per 1 currency_a; NULL = none found
      provider        TEXT,                                              -- 'manual', a provider id, or 'p1+p2' for a cross over two; NULL = none found
      via             TEXT,                                              -- intermediate currency of a cross rate; NULL = direct
      reference_date  TEXT,                                              -- 'YYYY-MM-DD' the data comes from; NULL = none found
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT,                                              -- ISO 8601 UTC instant; NULL = live
      CHECK (currency_a < currency_b)
    );
    CREATE INDEX idx_applied_rates_date ON applied_rates(date);

    CREATE TABLE transactions (
      id                       TEXT PRIMARY KEY,                         -- UUIDv7
      account_id__from         TEXT REFERENCES accounts(id) ON DELETE RESTRICT, -- short id; NULL = Global Economy (income)
      account_id__to           TEXT REFERENCES accounts(id) ON DELETE RESTRICT, -- short id; NULL = Global Economy (spend)
      amount_value__from       INTEGER NOT NULL,                         -- money: unscaled value
      amount_scale__from       INTEGER NOT NULL,                         -- money: decimal places
      amount_currency__from    TEXT NOT NULL,                            -- money: currency
      amount_value__to         INTEGER NOT NULL,                         -- money: unscaled value
      amount_scale__to         INTEGER NOT NULL,                         -- money: decimal places
      amount_currency__to      TEXT NOT NULL,                            -- money: currency
      transaction_at_local     TEXT NOT NULL,                            -- civil moment: offset-bearing ISO 8601
      transaction_at_zone      TEXT NOT NULL,                            -- civil moment: IANA zone name
      date_override_local      TEXT,                                     -- civil moment: offset-bearing ISO 8601
      date_override_zone       TEXT,                                     -- civil moment: IANA zone name
      tags                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), -- JSON array of plain-tag ids (short ids of tags with kind 'tag'; repository-checked)
      -- JSON array of category parts, each {"category_id", "amount_value__from", "amount_scale__from",
      -- "amount_value__to", "amount_scale__to"} in the transaction's currencies. At least one part,
      -- each category once, each side adding up exactly to the transaction's amount (repository-checked).
      categories               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),
      merchant_id              TEXT REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a merchant tag (repository-checked); NULL = none
      location_lat             REAL,                                     -- WGS84 degrees
      location_lon             REAL,                                     -- WGS84 degrees
      location_id              TEXT REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a location tag (repository-checked); NULL = none
      journey_id               TEXT REFERENCES tags(id) ON DELETE RESTRICT, -- short id of a journey tag (repository-checked); NULL = none
      description__user        TEXT,                                     -- the user's free-text note; NULL = none
      description__auto        TEXT CHECK (json_valid(description__auto)), -- JSON object from an import (OCR, bank API, statement, ...); NULL = entered by hand
      created_at_utc           TEXT NOT NULL,                            -- ISO 8601 UTC instant
      updated_at_utc           TEXT NOT NULL,                            -- ISO 8601 UTC instant
      deleted_at_utc           TEXT,                                     -- ISO 8601 UTC instant; NULL = live
      CHECK ((date_override_local IS NULL) = (date_override_zone IS NULL))
    );
    CREATE INDEX idx_transactions_account_from ON transactions(account_id__from) WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_account_to   ON transactions(account_id__to)   WHERE deleted_at_utc IS NULL;
    -- Tag references. Not partial: redirecting a merged tag rewrites rows of any liveness.
    CREATE INDEX idx_transactions_merchant     ON transactions(merchant_id);
    CREATE INDEX idx_transactions_location     ON transactions(location_id);
    CREATE INDEX idx_transactions_journey      ON transactions(journey_id);
    -- Offset-bearing ISO strings do not sort chronologically as text; julianday()
    -- normalizes them to UTC. The repository's ORDER BY must match these
    -- expressions exactly for SQLite to use the indexes (TRANSACTION_ORDER_BY).
    CREATE INDEX idx_transactions_at           ON transactions(julianday(transaction_at_local)) WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_effective_at ON transactions(julianday(COALESCE(date_override_local, transaction_at_local))) WHERE deleted_at_utc IS NULL;
  `,
}
