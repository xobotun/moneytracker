import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs'
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import * as SQLite from 'wa-sqlite'

export interface DatabaseOptions {
  /** Path to open. URI parsing is enabled globally (SQLITE_OPEN_URI), so a
   *  future caller must never thread a user-supplied string here unsanitized —
   *  a raw `file:...?vfs=X` URI could redirect to an unexpected VFS. */
  filePath?: string
  /** Use persistent storage (IndexedDB via IDBBatchAtomicVFS). Requires async WASM build. */
  persist?: boolean
  /**
   * Advanced: register this VFS as the connection's default VFS instead of
   * IDBBatchAtomicVFS (`persist: true`) or SQLite's built-in `:memory:`
   * handling (the default). Used by sqliteBlobCodec.openDatabaseFromBlob to
   * open a fresh Database against a wa-sqlite MemoryVFS pre-loaded with
   * blob bytes. Mutually exclusive with `persist` — both register a VFS as
   * default, so combining them would just mean the last one registered
   * (`vfs`, since it is checked first) wins silently.
   */
  vfs?: SQLiteVFS
}

export interface RunResult {
  changes: number
  lastInsertRowId: number
}

/**
 * The query surface shared by {@link Database} and the handle passed into
 * {@link Database.transaction}. Code that should work both standalone and
 * inside a transaction (e.g. sync row helpers) takes this instead of Database.
 */
export interface SqlExecutor {
  exec<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<RunResult>
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
  /** Serializes all async operations — Asyncify cannot handle concurrent WASM calls. */
  private mutex: Promise<void> = Promise.resolve()
  /** Monotonic counter bumped by every write through run(). Used by
   *  hashDatabase() to short-circuit re-hashing when nothing has changed.
   *  Reads (exec) do not bump. */
  mutationCounter = 0

  async init(options: DatabaseOptions = {}): Promise<void> {
    if (this.isOpen()) throw new Error('Database is already initialized')
    const module = await createSQLiteModule(!!options.persist)
    this.sqlite3 = SQLite.Factory(module)

    if (options.vfs) {
      // Caller-supplied VFS (e.g. a MemoryVFS pre-loaded with blob bytes for
      // import). Registered as default so a plain open_v2(filePath) below
      // resolves through it, same as the persist branch does for
      // IDBBatchAtomicVFS.
      this.sqlite3.vfs_register(options.vfs, true)
    } else if (options.persist) {
      // IDBBatchAtomicVFS persists to IndexedDB and works on the main thread.
      // Requires the async WASM build (wa-sqlite-async.mjs).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { IDBBatchAtomicVFS } = await import('wa-sqlite/src/examples/IDBBatchAtomicVFS.js' as any)
      const vfs = new IDBBatchAtomicVFS('moneytracker')
      this.sqlite3.vfs_register(vfs, true)
    }

    const filePath = options.filePath ?? ':memory:'
    // SQLITE_OPEN_URI (in addition to the READWRITE|CREATE wa-sqlite
    // otherwise defaults to) lets `file:...?vfs=...` strings be parsed as
    // URIs by this connection — needed so that sqliteBlobCodec's
    // `VACUUM INTO 'file:name?vfs=name'` can target a specific MemoryVFS.
    // Plain filenames (':memory:', bare names) are unaffected: URI parsing
    // only activates for strings that start with the "file:" scheme.
    this.db = await this.sqlite3.open_v2(
      filePath,
      SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI,
    )
    await this.run('PRAGMA foreign_keys = ON')
  }

  isOpen(): boolean {
    return this.sqlite3 !== null && this.db !== null
  }

  /**
   * Advanced escape hatch: registers `vfs` (non-default) on this Database's
   * own WASM module instance. Used by sqliteBlobCodec.exportDatabaseToBlob
   * to make a MemoryVFS reachable via `VACUUM INTO '...?vfs=<name>'` — the
   * target VFS named in that URI must be registered on the *same* module
   * that owns this connection, not a separate one, so this cannot be done
   * from outside without an accessor. Only registers the VFS; it does not
   * open or query anything, so it does not touch mutationCounter.
   */
  registerVfs(vfs: SQLiteVFS): void {
    this.ensureOpen()
    this.sqlite3!.vfs_register(vfs, false)
  }

  async exec<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.serialized(() => this.execUnsafe<T>(sql, params))
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    return this.serialized(() => this.runUnsafe(sql, params))
  }

  /**
   * Run `fn` as one atomic unit: BEGIN, `fn`, then COMMIT — or ROLLBACK and
   * rethrow if `fn` throws. The connection's lock is held for the whole unit,
   * so writes issued elsewhere meanwhile (e.g. by the UI) wait until it ends
   * instead of joining it and being rolled back with it.
   *
   * Inside `fn`, use only the `tx` handle. Calling this Database's own
   * `exec`/`run` from within `fn` deadlocks: those calls queue behind the lock
   * that the unit itself is holding.
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      let finished = false
      const guard = () => {
        if (finished) throw new Error('Database.transaction: handle used after the transaction finished')
      }
      const tx: SqlExecutor = {
        exec: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
          guard()
          return this.execUnsafe<R>(sql, params)
        },
        run: async (sql: string, params?: unknown[]) => {
          guard()
          return this.runUnsafe(sql, params)
        },
      }

      await this.runUnsafe('BEGIN')
      try {
        const result = await fn(tx)
        await this.runUnsafe('COMMIT')
        return result
      } catch (e) {
        try {
          await this.runUnsafe('ROLLBACK')
        } catch {
          // SQLite may already have rolled back (some errors abort the
          // transaction themselves); keep reporting the original error.
        }
        throw e
      } finally {
        finished = true
      }
    })
  }

  /**
   * Queues `fn` behind any pending operation so that only one WASM call
   * chain is active at a time. Errors are propagated to the caller without
   * blocking subsequent operations.
   */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn)
    // Keep the chain alive but swallow errors so a failed query doesn't
    // block everything that follows.
    this.mutex = next.then(() => {}, () => {})
    return next
  }

  private async execUnsafe<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
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

  private async runUnsafe(sql: string, params?: unknown[]): Promise<RunResult> {
    this.ensureOpen()
    // Bump the mutation counter for write keywords. The check is intentionally
    // cheap — we look only at the first word, case-insensitive. Statements
    // without one of these leading keywords are reads (or no-ops like PRAGMA
    // reads) and do not invalidate cached hashes.
    const leading = sql.trimStart().slice(0, 8).toUpperCase()
    if (
      leading.startsWith('INSERT') ||
      leading.startsWith('UPDATE') ||
      leading.startsWith('DELETE') ||
      leading.startsWith('REPLACE') ||
      leading.startsWith('ALTER') ||
      leading.startsWith('CREATE') ||
      leading.startsWith('DROP')
    ) {
      this.mutationCounter++
    }
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
