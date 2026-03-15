import type { Migration } from './index'

export const migration: Migration = {
  version: 1,
  up: `
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    )
  `,
}
