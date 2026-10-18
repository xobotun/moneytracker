import type { Database, SqlExecutor } from '../db/Database'
import { SYNC_COLUMNS, type ColumnDescriptor } from './syncColumns'
import { SYNC_TABLES, type SyncTable } from './syncTables'

// papaparse is loaded on first use (dynamic import) so it stays out of the
// startup bundle; CSV work only happens during a GitHub sync.
async function loadPapa() {
  return (await import('papaparse')).default
}

// CSV ↔ Database round-trip for GitHubCsvBackend.
//
// Export: SELECT columns FROM <table> ORDER BY <pk> with column order pinned
// by SYNC_COLUMNS, split into slices of ROWS_PER_CSV_FILE rows (one CSV text
// per slice, each with its own header; an empty table yields one header-only
// text); Papa.unparse for RFC 4180 quoting / embedded-newline /
// quote-in-cell escaping. Newline pinned to \n (matches .gitattributes; the
// platform default would produce CRLF on Windows).
//
// Import: Papa.parse with header: true, then one bulk INSERT per table via
// json_each(?). wa-sqlite's Asyncify build penalises every await on the DB
// (each is a stack-unwind yield-point) — per-row parametrised INSERTs would
// be O(rows * roundtrips); the json_each approach is O(tables) roundtrips.
// Coercion lives in the SELECT list per SYNC_COLUMNS:
//   INTEGER   → CAST(json_extract(value, '$.col') AS INTEGER)
//   REAL      → CAST(json_extract(value, '$.col') AS REAL)
//   TEXT null → nullif(json_extract(value, '$.col'), '')
//   TEXT !null→ json_extract(value, '$.col')

/**
 * Data rows per CSV file. Why 1000: it keeps every file far below GitHub's
 * 1 MB contents limit (about 300-400 KB for transactions) and keeps each
 * sync's diff small. Rows are in primary-key order and UUIDv7 keys are
 * time-ordered, so new rows land in the last file and earlier files stay
 * byte-identical (git stores them once).
 *
 * This is a fixed format constant: NEVER change it. Uploads only add or
 * rewrite files and never delete any, so a smaller value would leave rows
 * duplicated across files, and a larger one would leave stale trailing files
 * whose rows are also in an earlier file. The next download then fails on
 * duplicate primary keys on every device until the files are removed by
 * hand. Tables never shrink in normal use (deletes are soft), so with a
 * fixed limit the file set only grows.
 */
export const ROWS_PER_CSV_FILE = 1000

/** The table as CSV texts of at most `rowsPerFile` rows, in primary-key order (always at least one). */
export async function exportTableToCsvFiles(
  db: SqlExecutor,
  table: SyncTable,
  rowsPerFile = ROWS_PER_CSV_FILE,
): Promise<string[]> {
  const columns = SYNC_COLUMNS[table.name]
  if (!columns) throw new Error(`csvCodec: no syncColumns descriptor for "${table.name}"`)
  const columnList = columns.map((c) => c.name).join(', ')
  const rows = await db.exec<Record<string, unknown>>(
    `SELECT ${columnList} FROM ${table.name} ORDER BY ${table.pk}`,
  )
  // Passed as { fields, data } rather than a bare array-of-objects with a
  // `columns` config: Papa.unparse's array-of-objects path (see
  // node_modules/papaparse/papaparse.js JsonToCsv, `!_input.length` branch)
  // ignores the `columns` config entirely when the array is empty and
  // falls back to `serialize(null, ...)`, silently dropping the header row
  // for a table with zero rows. The { fields, data } object form always
  // honours the explicit `fields` list, header included, regardless of
  // whether `data` is empty — required for exportAllTables bundles where an
  // as-yet-unpopulated table's CSV is still "header,row\n" and every table's
  // header line is column-count-comparable to a later appended data row.
  const Papa = await loadPapa()
  const fields = columns.map((c) => c.name)
  const files: string[] = []
  // `do … while` so an empty table still yields one header-only file.
  let start = 0
  do {
    const data = rows.slice(start, start + rowsPerFile)
    const csv = Papa.unparse({ fields, data }, { header: true, newline: '\n' })
    // Papa ends a header-only output with a newline already, but not one that has rows.
    files.push(csv.endsWith('\n') ? csv : csv + '\n')
    start += rowsPerFile
  } while (start < rows.length)
  return files
}

export async function importCsvIntoTable(
  db: SqlExecutor,
  table: SyncTable,
  csvText: string,
): Promise<void> {
  const columns = SYNC_COLUMNS[table.name]
  if (!columns) throw new Error(`csvCodec: no syncColumns descriptor for "${table.name}"`)

  const Papa = await loadPapa()
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    // Pinned to ',': exportTableToCsvFiles always writes comma-delimited CSV
    // (Papa.unparse's default). Without this, Papa's delimiter auto-detect
    // has no data row to sample on a header-only CSV and reports a
    // (non-fatal, but still populated into `errors`) "Unable to
    // auto-detect delimiting character" warning that would otherwise trip
    // the `parsed.errors.length > 0` guard below.
    delimiter: ',',
  })
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0]!
    throw new Error(
      `csvCodec.importCsvIntoTable(${table.name}): CSV parse error at row ${e.row}: ${e.message}`,
    )
  }
  if (parsed.data.length === 0) return

  const columnList = columns.map((c) => c.name).join(', ')
  const selectList = columns.map(selectExpressionFor).join(',\n  ')
  await db.run(
    `INSERT INTO ${table.name} (${columnList})
     SELECT
       ${selectList}
     FROM json_each(?)`,
    [JSON.stringify(parsed.data)],
  )
}

function selectExpressionFor(c: ColumnDescriptor): string {
  const path = `'$.${c.name}'`
  // Nullable columns round-trip NULL as an empty CSV cell; nullif() turns
  // that back into SQL NULL before any CAST. Without this, CAST('' AS REAL)
  // (and CAST('' AS INTEGER)) evaluate to 0 in SQLite rather than NULL —
  // verified directly against wa-sqlite — silently corrupting a NULL
  // latitude/longitude (etc.) into 0 on import.
  const extracted = c.nullable
    ? `nullif(json_extract(value, ${path}), '')`
    : `json_extract(value, ${path})`
  if (c.sqlType === 'INTEGER') return `CAST(${extracted} AS INTEGER)`
  if (c.sqlType === 'REAL') return `CAST(${extracted} AS REAL)`
  return extracted
}

/**
 * Export every domain table to a Map<name, csv files> (see
 * exportTableToCsvFiles). Insertion order matches SYNC_TABLES. All tables are read inside one transaction so the export is a
 * consistent snapshot: an app write cannot land between two table reads
 * (e.g. a transaction exported without the account it references).
 */
export async function exportAllTables(
  db: Database,
  rowsPerFile = ROWS_PER_CSV_FILE,
): Promise<Map<string, string[]>> {
  // Load the library BEFORE taking the database lock: a slow chunk download
  // inside the transaction would freeze every other query of the app.
  await loadPapa()
  return db.transaction(async (tx) => {
    const out = new Map<string, string[]>()
    for (const t of SYNC_TABLES) out.set(t.name, await exportTableToCsvFiles(tx, t, rowsPerFile))
    return out
  })
}

/**
 * Import every domain table from a Map<name, csv files> in FK order (parents before
 * children, per SYNC_TABLES). Wrapped in a single BEGIN/COMMIT so a mid-
 * import failure (FK violation, malformed CSV, missing entry) rolls back
 * cleanly rather than leaving a partially-populated DB.
 */
export async function importAllTables(db: Database, bundle: Map<string, string[]>): Promise<void> {
  await loadPapa() // before the lock — see exportAllTables
  await db.transaction(async (tx) => {
    for (const t of SYNC_TABLES) {
      const csvs = bundle.get(t.name)
      if (csvs === undefined) {
        throw new Error(`csvCodec.importAllTables: missing CSV for "${t.name}"`)
      }
      for (const csv of csvs) await importCsvIntoTable(tx, t, csv)
    }
  })
}
