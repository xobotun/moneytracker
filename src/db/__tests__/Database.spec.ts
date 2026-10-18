import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../Database'
import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js'

describe('Database', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('initializes an in-memory database', async () => {
    db = new Database()
    await db.init()
    expect(db.isOpen()).toBe(true)
  })

  it('executes a CREATE TABLE and INSERT', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
    await db.run('INSERT INTO test (name) VALUES (?)', ['hello'])
    const rows = await db.exec<{ id: number; name: string }>('SELECT * FROM test')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('hello')
  })

  it('returns changes and lastInsertRowId from run()', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
    const result = await db.run('INSERT INTO test (name) VALUES (?)', ['hello'])
    expect(result.changes).toBe(1)
    expect(result.lastInsertRowId).toBe(1)
  })

  it('supports parameterized queries in exec()', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
    await db.run('INSERT INTO test (val) VALUES (?)', ['a'])
    await db.run('INSERT INTO test (val) VALUES (?)', ['b'])
    const rows = await db.exec<{ val: string }>('SELECT val FROM test WHERE val = ?', ['b'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.val).toBe('b')
  })

  it('throws on double init()', async () => {
    db = new Database()
    await db.init()
    await expect(db.init()).rejects.toThrow('already initialized')
  })

  it('close() prevents further operations', async () => {
    db = new Database()
    await db.init()
    await db.close()
    await expect(db.exec('SELECT 1')).rejects.toThrow()
  })

  it('has foreign_keys pragma enabled', async () => {
    db = new Database()
    await db.init()
    const rows = await db.exec<{ foreign_keys: number }>('PRAGMA foreign_keys')
    expect(rows[0]!.foreign_keys).toBe(1)
  })

  it('enforces foreign key constraints', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE parent (id TEXT PRIMARY KEY)')
    await db.run('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))')
    await expect(
      db.run('INSERT INTO child (id, parent_id) VALUES (?, ?)', ['c1', 'missing'])
    ).rejects.toThrow()
  })

  it('opens against a caller-supplied VFS pre-loaded with an existing file', async () => {
    // Build a source database, then hand-roll a MemoryVFS file the way
    // sqliteBlobCodec.exportDatabaseToBlob does (via VACUUM INTO), and
    // verify Database.init({ vfs, filePath }) opens straight into it rather
    // than creating a fresh empty database under that name.
    const source = new Database()
    await source.init()
    await source.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await source.run("INSERT INTO t (id, name) VALUES (1, 'hello')")

    const exportVfs = new MemoryVFS()
    exportVfs.name = 'database-spec-export-vfs'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source.registerVfs(exportVfs as any)
    await source.run(`VACUUM INTO 'file:exported?vfs=${exportVfs.name}'`)
    await source.close()

    const [file] = exportVfs.mapNameToFile.values() as IterableIterator<{
      data: ArrayBuffer
      size: number
    }>
    expect(file).toBeDefined()

    const importVfs = new MemoryVFS()
    importVfs.name = 'database-spec-import-vfs'
    importVfs.mapNameToFile.set('imported', {
      name: 'imported',
      flags: 0,
      size: file!.size,
      data: file!.data.slice(0, file!.size),
    })

    db = new Database()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.init({ filePath: 'imported', vfs: importVfs as any })
    const rows = await db.exec<{ id: number; name: string }>('SELECT * FROM t')
    expect(rows).toEqual([{ id: 1, name: 'hello' }])
  })
})

describe('mutationCounter', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('starts at 0 on a fresh database', async () => {
    db = new Database()
    await db.init()
    expect(db.mutationCounter).toBe(0)
  })

  it('bumps on INSERT', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const before = db.mutationCounter
    await db.run('INSERT INTO t (id) VALUES (1)')
    expect(db.mutationCounter).toBe(before + 1)
  })

  it('bumps on UPDATE, DELETE, REPLACE', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    await db.run('INSERT INTO t (id, name) VALUES (1, ?)', ['a'])
    const before = db.mutationCounter
    await db.run('UPDATE t SET name = ? WHERE id = 1', ['b'])
    await db.run('DELETE FROM t WHERE id = 1')
    await db.run('REPLACE INTO t (id, name) VALUES (1, ?)', ['c'])
    expect(db.mutationCounter).toBe(before + 3)
  })

  it('bumps on schema changes (CREATE, ALTER, DROP)', async () => {
    db = new Database()
    await db.init()
    const before = db.mutationCounter
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.run('ALTER TABLE t ADD COLUMN name TEXT')
    await db.run('DROP TABLE t')
    expect(db.mutationCounter).toBe(before + 3)
  })

  it('does not bump on exec() reads', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.run('INSERT INTO t (id) VALUES (1)')
    const before = db.mutationCounter
    await db.exec('SELECT * FROM t')
    await db.exec<{ c: number }>('SELECT COUNT(*) AS c FROM t')
    expect(db.mutationCounter).toBe(before)
  })

  it('is case-insensitive on the leading keyword', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const before = db.mutationCounter
    await db.run('  insert  into t (id) values (1)')
    expect(db.mutationCounter).toBe(before + 1)
  })
})

describe('Database.transaction', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  async function freshDb(): Promise<Database> {
    const d = new Database()
    await d.init()
    await d.run('CREATE TABLE t (name TEXT NOT NULL)')
    return d
  }

  async function names(d: Database): Promise<string[]> {
    return (await d.exec<{ name: string }>('SELECT name FROM t ORDER BY name')).map((r) => r.name)
  }

  it('commits the unit and returns its result', async () => {
    db = await freshDb()
    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('a')")
      await tx.run("INSERT INTO t VALUES ('b')")
      return (await tx.exec<{ n: number }>('SELECT count(*) AS n FROM t'))[0]!.n
    })
    expect(result).toBe(2)
    expect(await names(db)).toEqual(['a', 'b'])
  })

  it('rolls back the unit and rethrows on failure', async () => {
    db = await freshDb()
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES ('a')")
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await names(db)).toEqual([])
  })

  it('keeps a write issued concurrently from elsewhere out of the unit (it runs after, and survives a rollback)', async () => {
    db = await freshDb()
    let outside: Promise<unknown> | undefined
    const unit = db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES ('inside')")
      // Another caller (e.g. the UI) writes while the unit is in flight.
      outside = db.run("INSERT INTO t VALUES ('outside')")
      await tx.exec('SELECT 1')
      throw new Error('unit failed')
    })
    await expect(unit).rejects.toThrow('unit failed')
    await outside
    expect(await names(db)).toEqual(['outside'])
  })

  it('reports the original error even when ROLLBACK itself fails', async () => {
    db = await freshDb()
    await expect(
      db.transaction(async (tx) => {
        await tx.run('ROLLBACK') // leave no active transaction, so the outer ROLLBACK fails
        throw new Error('original')
      }),
    ).rejects.toThrow('original')
  })

  it('refuses to use the transaction handle after the unit has finished', async () => {
    db = await freshDb()
    let leaked: { run(sql: string): Promise<unknown> } | undefined
    await db.transaction(async (tx) => {
      leaked = tx
    })
    await expect(leaked!.run("INSERT INTO t VALUES ('late')")).rejects.toThrow(/finished/)
  })
})

describe('Database.transaction — calls on the tx handle', () => {
  let db: Database

  afterEach(async () => {
    if (db) await db.close()
  })

  it('serializes tx calls issued concurrently and finishes them before COMMIT', async () => {
    db = new Database()
    await db.init()
    await db.run('CREATE TABLE t (n INTEGER NOT NULL)')
    await db.transaction(async (tx) => {
      // Concurrent (Promise.all) and even un-awaited calls on tx must still run
      // one at a time, in call order, and complete before the unit commits.
      await Promise.all([1, 2, 3].map((n) => tx.run('INSERT INTO t VALUES (?)', [n])))
      void tx.run('INSERT INTO t VALUES (4)')
    })
    const rows = await db.exec<{ n: number }>('SELECT n FROM t ORDER BY rowid')
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4])
  })
})
