import type { Database } from '../db/Database'
import { SYNC_TABLES, type SyncTable } from './syncTables'
import { EQUALITY_IGNORED_COLUMNS } from './syncColumns'
import type { SyncRow } from './types'

// Provider-independent content hash of a Database.
//
// Walks SYNC_TABLES in declared order. For each table, reads every row sorted
// by primary key, emits a canonical JSON line per row (keys sorted
// alphabetically, no whitespace), and accumulates into a SHA-256.
//
// "Content-based" is load-bearing: the hash is over the rows, not over a
// storage form (CSV bytes, .sqlite bytes). Two backends that have synced
// the same logical database produce the same hash, so switching providers
// does not invalidate `lastKnownRemoteState.hash`.
//
// Cached per-Database via a module-level WeakMap keyed on the Database
// instance. The cache key is the Database's mutationCounter — if the
// counter has not advanced since the cached entry, the cached hash is
// returned without re-walking any rows. The WeakMap lets a closed Database
// be garbage-collected with its cache entry.

interface CacheEntry {
  hash: string
  atMutation: number
}

let cache = new WeakMap<Database, CacheEntry>()

/** Test-only: clears the cache. Production code never calls this. */
export function __resetHashCache(): void {
  cache = new WeakMap()
}

/**
 * The line `hashDatabase` hashes for one row (it adds the trailing newline).
 *
 * Canonical JSON: keys sorted alphabetically, no whitespace, undefined
 * omitted, NULL preserved. JSON.stringify already omits undefined and
 * preserves null; we add explicit key sorting. Columns the merge ignores are
 * left out too (a device-computed cache, the timestamps of independently
 * computed rows): they are not part of the data. Shared with the per-row hash
 * of the sync base so the two can never drift.
 */
export function canonicalLine(table: SyncTable, row: SyncRow): string {
  const ignored = EQUALITY_IGNORED_COLUMNS[table.name] ?? []
  const sortedKeys = Object.keys(row)
    .filter((key) => !ignored.includes(key))
    .sort()
  return `${table.name} ${JSON.stringify(row, sortedKeys)}`
}

/** `sha256:<hex>` over the lines in order, each ended by a newline. */
export async function hashLines(lines: string[]): Promise<string> {
  // crypto.subtle.digest works on the assembled byte buffer. For a small
  // personal-finance DB this fits comfortably in memory; if we ever push
  // past ~50MB of row text we'd switch to a streaming SHA-256 (an
  // off-the-shelf one — Web Crypto does not stream).
  const buffer = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''))
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

export async function hashDatabase(db: Database): Promise<string> {
  const cached = cache.get(db)
  if (cached && cached.atMutation === db.mutationCounter) {
    return cached.hash
  }

  // Capture the counter BEFORE walking the tables. Each table read is a
  // separate queued call, so an app write can land between two of them. Had
  // we read the counter after the walk, it would already include that write
  // while the hash does not, and the stale hash would be served from the cache
  // until the next unrelated write. Read before, a mid-walk write leaves the
  // entry outdated, so the next call re-hashes.
  const atMutation = db.mutationCounter

  const lines: string[] = []
  for (const table of SYNC_TABLES) {
    const rows = await db.exec<SyncRow>(`SELECT * FROM ${table.name} ORDER BY ${table.pk}`)
    for (const row of rows) lines.push(canonicalLine(table, row))
  }
  const result = await hashLines(lines)

  cache.set(db, { hash: result, atMutation })
  return result
}
