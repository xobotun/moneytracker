import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs'
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import * as SQLite from 'wa-sqlite'

export interface DatabaseOptions {
  filePath?: string
  /** Use persistent storage (IndexedDB via IDBBatchAtomicVFS). Requires async WASM build. */
  persist?: boolean
}

export interface RunResult {
  changes: number
  lastInsertRowId: number
}

/**
 * Loads the wa-sqlite WASM binary. In Node/test environments, fetch may not
 * support the file:// URLs that wa-sqlite uses, so we read the .wasm file
 * from disk and pass it directly as `wasmBinary`.
 */
async function createSQLiteModule(async_: boolean): Promise<ReturnType<typeof SQLiteESMFactory>> {
  const factory = async_ ? SQLiteAsyncESMFactory : SQLiteESMFactory

  // In Node-like environments (Vitest/jsdom), load WASM from disk
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined
  if (proc?.versions?.node) {
    const fs = await import('node:fs/promises')
    const mod = await import('node:module')

    const require = mod.createRequire(import.meta.url)
    const wasmFile = async_ ? 'wa-sqlite/dist/wa-sqlite-async.wasm' : 'wa-sqlite/dist/wa-sqlite.wasm'
    const wasmPath = require.resolve(wasmFile)
    const wasmBinary = await fs.readFile(wasmPath)
    return factory({ wasmBinary })
  }
  // In browser environments, the default fetch-based loading works fine
  return factory()
}

export class Database {
  private sqlite3: SQLiteAPI | null = null
  private db: number | null = null

  async init(options: DatabaseOptions = {}): Promise<void> {
    if (this.isOpen()) throw new Error('Database is already initialized')
    const module = await createSQLiteModule(!!options.persist)
    this.sqlite3 = SQLite.Factory(module)

    if (options.persist) {
      // IDBBatchAtomicVFS persists to IndexedDB and works on the main thread.
      // Requires the async WASM build (wa-sqlite-async.mjs).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { IDBBatchAtomicVFS } = await import('wa-sqlite/src/examples/IDBBatchAtomicVFS.js' as any)
      const vfs = new IDBBatchAtomicVFS('moneytracker')
      this.sqlite3.vfs_register(vfs, true)
    }

    const filePath = options.filePath ?? ':memory:'
    this.db = await this.sqlite3.open_v2(filePath)
  }

  isOpen(): boolean {
    return this.sqlite3 !== null && this.db !== null
  }

  async exec<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureOpen()
    const rows: T[] = []
    for await (const stmt of this.sqlite3!.statements(this.db!, sql)) {
      if (params) {
        this.sqlite3!.bind_collection(stmt, params as SQLiteCompatibleType[])
      }
      const columns = this.sqlite3!.column_names(stmt)
      while ((await this.sqlite3!.step(stmt)) === SQLite.SQLITE_ROW) {
        const row = this.sqlite3!.row(stmt)
        const obj = Object.fromEntries(columns.map((col, i) => [col, row[i]])) as T
        rows.push(obj)
      }
    }
    return rows
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    this.ensureOpen()
    for await (const stmt of this.sqlite3!.statements(this.db!, sql)) {
      if (params) {
        this.sqlite3!.bind_collection(stmt, params as SQLiteCompatibleType[])
      }
      await this.sqlite3!.step(stmt)
    }
    const changes = this.sqlite3!.changes(this.db!)
    // wa-sqlite doesn't expose sqlite3_last_insert_rowid as a method,
    // so we query it via SQL instead.
    let lastInsertRowId = 0
    for await (const stmt of this.sqlite3!.statements(this.db!, 'SELECT last_insert_rowid()')) {
      if ((await this.sqlite3!.step(stmt)) === SQLite.SQLITE_ROW) {
        const row = this.sqlite3!.row(stmt)
        lastInsertRowId = Number(row[0])
      }
    }
    return { changes, lastInsertRowId }
  }

  async close(): Promise<void> {
    if (this.sqlite3 && this.db !== null) {
      await this.sqlite3.close(this.db)
    }
    this.sqlite3 = null
    this.db = null
  }

  private ensureOpen(): void {
    if (!this.sqlite3 || this.db === null) {
      throw new Error('Database is not open')
    }
  }
}
