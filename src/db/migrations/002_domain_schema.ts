import type { Migration } from './index'

// Column comments record the semantic type that SQLite's five affinities
// cannot express (see CLAUDE.md "SQLite Conventions"). Keep the `up` string
// starting with a statement keyword, not a comment: Database.mutationCounter
// classifies writes by their leading keyword.
export const migration: Migration = {
  version: 2,
  up: `
    CREATE TABLE locations (
      id              TEXT PRIMARY KEY,                                  -- UUIDv7
      name            TEXT NOT NULL,
      description     TEXT,
      address         TEXT,
      city            TEXT,
      country         TEXT,
      latitude        REAL,                                              -- WGS84 degrees
      longitude       REAL,                                              -- WGS84 degrees
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), -- JSON array of tag names
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE tags (
      tag             TEXT PRIMARY KEY,                                  -- natural key: the tag name itself
      description     TEXT,
      synonyms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms)), -- JSON array of strings
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE account_groupings (
      id              TEXT PRIMARY KEY,                                  -- UUIDv7
      name            TEXT NOT NULL,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      sort_order      INTEGER NOT NULL DEFAULT 0,                        -- position among the groups, ascending; ties by name
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

    CREATE TABLE accounts (
      id              TEXT PRIMARY KEY,                                  -- UUIDv7
      name            TEXT NOT NULL,
      currency        TEXT NOT NULL,                                     -- money currency of balance_* (ISO 4217 or custom)
      balance_value   INTEGER NOT NULL,                                  -- money: unscaled value
      balance_scale   INTEGER NOT NULL,                                  -- money: decimal places
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), -- JSON array of tag names
      location_id     TEXT REFERENCES locations(id) ON DELETE RESTRICT,  -- UUIDv7
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      grouping_id     TEXT REFERENCES account_groupings(id) ON DELETE RESTRICT, -- UUIDv7; NULL = not in a group
      sort_order      INTEGER NOT NULL DEFAULT 0,                        -- position within its group (or among ungrouped accounts), ascending; ties by name
      created_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      updated_at_utc  TEXT NOT NULL,                                     -- ISO 8601 UTC instant
      deleted_at_utc  TEXT                                               -- ISO 8601 UTC instant; NULL = live
    );

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

    CREATE TABLE transactions (
      id                       TEXT PRIMARY KEY,                         -- UUIDv7
      account_id__from         TEXT REFERENCES accounts(id) ON DELETE RESTRICT, -- UUIDv7; NULL = Global Economy (income)
      account_id__to           TEXT REFERENCES accounts(id) ON DELETE RESTRICT, -- UUIDv7; NULL = Global Economy (spend)
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
      tags                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)), -- JSON array of tag names
      location_lat             REAL,                                     -- WGS84 degrees
      location_lon             REAL,                                     -- WGS84 degrees
      location_id              TEXT REFERENCES locations(id) ON DELETE RESTRICT, -- UUIDv7
      created_at_utc           TEXT NOT NULL,                            -- ISO 8601 UTC instant
      updated_at_utc           TEXT NOT NULL,                            -- ISO 8601 UTC instant
      deleted_at_utc           TEXT,                                     -- ISO 8601 UTC instant; NULL = live
      CHECK ((date_override_local IS NULL) = (date_override_zone IS NULL))
    );
    CREATE INDEX idx_transactions_account_from ON transactions(account_id__from) WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_account_to   ON transactions(account_id__to)   WHERE deleted_at_utc IS NULL;
    -- Offset-bearing ISO strings do not sort chronologically as text; julianday()
    -- normalizes them to UTC. The repository's ORDER BY must match these
    -- expressions exactly for SQLite to use the indexes (TRANSACTION_ORDER_BY).
    CREATE INDEX idx_transactions_at           ON transactions(julianday(transaction_at_local)) WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_effective_at ON transactions(julianday(COALESCE(date_override_local, transaction_at_local))) WHERE deleted_at_utc IS NULL;
  `,
}
