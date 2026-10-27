import type { Migration } from './index'

// The sync base: what each row looked like when this device last agreed with
// its remote, as one short hash per row (see src/sync/syncBase.ts). The merge
// compares a row against its base hash to tell "changed here" from "unchanged
// here" without any timestamp cutoff. Both tables are device-local, like
// `settings`: no sync columns, not in SYNC_TABLES, never merged or written to
// CSV (they still ride along in a SQLite-blob upload, where nobody reads them).
export const migration: Migration = {
  version: 3,
  up: `
    CREATE TABLE sync_base (
      table_name TEXT NOT NULL,  -- a SYNC_TABLES name
      pk         TEXT NOT NULL,  -- the row's primary key
      row_hash   TEXT NOT NULL,  -- rowHash(): hex of the first 16 bytes of SHA-256
      PRIMARY KEY (table_name, pk)
    ) WITHOUT ROWID;

    CREATE TABLE sync_base_info (
      id             INTEGER PRIMARY KEY CHECK (id = 1),  -- a single row
      remote_id      TEXT NOT NULL,     -- SyncBackend.remoteId the base was agreed with
      database_hash  TEXT NOT NULL,     -- hashDatabase() of the rows the base holds
      schema_version INTEGER NOT NULL   -- migration version the rows were hashed at
    )
  `,
}
