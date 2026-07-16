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
