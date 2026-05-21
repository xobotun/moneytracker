import type { Migration } from './index'

export const migration: Migration = {
  version: 2,
  up: `
    CREATE TABLE locations (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      description     TEXT,
      address         TEXT,
      city            TEXT,
      country         TEXT,
      latitude        REAL,
      longitude       REAL,
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE tags (
      tag             TEXT PRIMARY KEY,
      description     TEXT,
      synonyms        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(synonyms)),
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE accounts (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      currency        TEXT NOT NULL,
      balance_value   INTEGER NOT NULL,
      balance_scale   INTEGER NOT NULL,
      tags            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      location_id     TEXT REFERENCES locations(id) ON DELETE RESTRICT,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE exchange_rates (
      id              TEXT PRIMARY KEY,
      date            TEXT NOT NULL,
      base_currency   TEXT NOT NULL,
      rates           TEXT NOT NULL CHECK (json_valid(rates)),
      provider        TEXT NOT NULL,
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );
    CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(date, base_currency);

    CREATE TABLE account_groupings (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      colour          TEXT NOT NULL,
      icon            TEXT NOT NULL,
      accounts_ids    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(accounts_ids)),
      created_at_utc  TEXT NOT NULL,
      updated_at_utc  TEXT NOT NULL,
      deleted_at_utc  TEXT
    );

    CREATE TABLE transactions (
      id                       TEXT PRIMARY KEY,
      account_id__from         TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
      account_id__to           TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
      amount_value__from       INTEGER NOT NULL,
      amount_scale__from       INTEGER NOT NULL,
      amount_currency__from    TEXT NOT NULL,
      amount_value__to         INTEGER NOT NULL,
      amount_scale__to         INTEGER NOT NULL,
      amount_currency__to      TEXT NOT NULL,
      transaction_at_local     TEXT NOT NULL,
      transaction_at_zone      TEXT NOT NULL,
      date_override_local      TEXT,
      date_override_zone       TEXT,
      tags                     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
      location_lat             REAL,
      location_lon             REAL,
      location_id              TEXT REFERENCES locations(id) ON DELETE RESTRICT,
      created_at_utc           TEXT NOT NULL,
      updated_at_utc           TEXT NOT NULL,
      deleted_at_utc           TEXT
    );
    CREATE INDEX idx_transactions_account_from ON transactions(account_id__from)     WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_account_to   ON transactions(account_id__to)       WHERE deleted_at_utc IS NULL;
    CREATE INDEX idx_transactions_at_local     ON transactions(transaction_at_local) WHERE deleted_at_utc IS NULL;
  `,
}
