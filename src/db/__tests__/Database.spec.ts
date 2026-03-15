import { describe, it, expect, afterEach } from 'vitest'
import { Database } from '../Database'

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
})
