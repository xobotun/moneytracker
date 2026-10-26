import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../Database'
import { ALL_MIGRATIONS, runMigrations } from '../migrations'
import { asShortId, type ShortId } from '../shortId'
import { asUuid, newId, type UUID } from '../uuid'
import type { TagKind } from '../types'
import { moneyAmount } from '../MoneyAmount'
import { TransactionsRepository } from '../repositories/TransactionsRepository'
import { assertTransactionRules } from '../repositories/transactionRules'
import { countTagUsage, redirectTagReferences } from '../tagReferences'

const AT = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-26T12:00:00.000Z'

/** A category part as stored: [category id, value from, scale from, value to, scale to]. */
type Part = [ShortId, number, number, number, number]

describe('tag references', () => {
  let db: Database

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
  })

  afterEach(async () => {
    await db.close()
  })

  // Raw inserts: the rows a redirect meets may break today's repository rules
  // (deleted references, rows brought in by sync).

  async function tag(
    id: string,
    kind: TagKind,
    name: string,
    opts: { parent?: ShortId; deleted?: boolean } = {},
  ): Promise<ShortId> {
    await db.run(
      `INSERT INTO tags (id, kind, name, parent_id, created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, name, opts.parent ?? null, AT, AT, opts.deleted ? AT : null],
    )
    return asShortId(id)
  }

  async function account(
    id: string,
    opts: { tags?: ShortId[]; location?: ShortId; deleted?: boolean } = {},
  ): Promise<ShortId> {
    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, tags, location_id,
                             colour, icon, created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, 'EUR', 0, 2, ?, ?, '#000000', 'wallet', ?, ?, ?)`,
      [
        id,
        id,
        JSON.stringify(opts.tags ?? []),
        opts.location ?? null,
        AT,
        AT,
        opts.deleted ? AT : null,
      ],
    )
    return asShortId(id)
  }

  async function transaction(opts: {
    from?: ShortId | null
    amountFrom?: [number, number, string]
    amountTo?: [number, number, string]
    categories?: Part[]
    tags?: ShortId[]
    merchant?: ShortId
    location?: ShortId
    journey?: ShortId
    deleted?: boolean
  }): Promise<UUID> {
    const id = newId()
    const [vf, sf, cf] = opts.amountFrom ?? [100, 2, 'EUR']
    const [vt, st, ct] = opts.amountTo ?? [100, 2, 'EUR']
    const categories = (opts.categories ?? []).map(([category_id, vFrom, sFrom, vTo, sTo]) => ({
      category_id,
      amount_value__from: vFrom,
      amount_scale__from: sFrom,
      amount_value__to: vTo,
      amount_scale__to: sTo,
    }))
    await db.run(
      `INSERT INTO transactions (id, account_id__from, account_id__to,
         amount_value__from, amount_scale__from, amount_currency__from,
         amount_value__to, amount_scale__to, amount_currency__to,
         transaction_at_local, transaction_at_zone, tags, categories,
         merchant_id, location_id, journey_id, created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, '2026-10-25T12:00:00.000+02:00', 'Europe/Berlin',
               ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        opts.from ?? null,
        vf,
        sf,
        cf,
        vt,
        st,
        ct,
        JSON.stringify(opts.tags ?? []),
        JSON.stringify(categories),
        opts.merchant ?? null,
        opts.location ?? null,
        opts.journey ?? null,
        AT,
        AT,
        opts.deleted ? AT : null,
      ],
    )
    return id
  }

  async function row(table: string, key: string, id: string): Promise<Record<string, unknown>> {
    const rows = await db.exec(`SELECT * FROM ${table} WHERE ${key} = ?`, [id])
    return rows[0]!
  }

  const redirect = (from: ShortId, to: ShortId, bump = false) =>
    db.transaction((tx) => redirectTagReferences(tx, from, to, { bump, now: NOW }))

  it('rewrites every kind of reference', async () => {
    const reweX = await tag('reweX0000001', 'merchant', 'REWE Markt')
    const reweY = await tag('reweY0000001', 'merchant', 'Rewe')
    const foodX = await tag('foodX0000001', 'category', 'Everyday food')
    const foodY = await tag('foodY0000001', 'category', 'Groceries')
    const fruit = await tag('fruit0000001', 'category', 'Fruit', { parent: foodX })
    const oldVeg = await tag('oldveg000001', 'category', 'Veg', { parent: foodX, deleted: true })
    const alexX = await tag('alexX0000001', 'location', 'Alexa')
    const alexY = await tag('alexY0000001', 'location', 'Alexanderplatz')
    const tripX = await tag('tripX0000001', 'journey', 'Lisbon 2026')
    const tripY = await tag('tripY0000001', 'journey', 'Summer 2026')
    const workX = await tag('workX0000001', 'tag', 'job')
    const workY = await tag('workY0000001', 'tag', 'work')
    const other = await tag('other0000001', 'tag', 'other')

    const wallet = await account('wallet000001', { tags: [workX, other], location: alexX })
    const closed = await account('closed000001', { tags: [workX], deleted: true })
    const live = await transaction({
      categories: [[foodX, 100, 2, 100, 2]],
      tags: [other, workX],
      merchant: reweX,
      location: alexX,
    })
    const deleted = await transaction({
      categories: [[foodX, 100, 2, 100, 2]],
      journey: tripX,
      deleted: true,
    })
    await db.run(
      `INSERT INTO location_details (tag_id, merchant_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?)`,
      [alexY, reweX, AT, AT],
    )
    await db.run(
      `INSERT INTO merchant_details (tag_id, default_category_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?)`,
      [reweY, foodX, AT, AT],
    )

    await redirect(reweX, reweY)
    await redirect(foodX, foodY)
    await redirect(alexX, alexY)
    await redirect(tripX, tripY)
    await redirect(workX, workY)

    expect(await row('transactions', 'id', live)).toMatchObject({
      merchant_id: reweY,
      location_id: alexY,
      tags: JSON.stringify([other, workY]),
    })
    expect(JSON.parse((await row('transactions', 'id', live)).categories as string)).toEqual([
      {
        category_id: foodY,
        amount_value__from: 100,
        amount_scale__from: 2,
        amount_value__to: 100,
        amount_scale__to: 2,
      },
    ])
    expect(await row('transactions', 'id', deleted)).toMatchObject({ journey_id: tripY })
    expect(JSON.parse((await row('transactions', 'id', deleted)).categories as string)).toEqual([
      expect.objectContaining({ category_id: foodY }),
    ])
    expect(await row('accounts', 'id', wallet)).toMatchObject({
      location_id: alexY,
      tags: JSON.stringify([workY, other]),
    })
    expect(await row('accounts', 'id', closed)).toMatchObject({ tags: JSON.stringify([workY]) })
    expect(await row('location_details', 'tag_id', alexY)).toMatchObject({ merchant_id: reweY })
    expect(await row('merchant_details', 'tag_id', reweY)).toMatchObject({
      default_category_id: foodY,
    })
    expect(await row('tags', 'id', fruit)).toMatchObject({ parent_id: foodY })
    expect(await row('tags', 'id', oldVeg)).toMatchObject({ parent_id: foodY })
  })

  it('drops a plain tag that would be there twice', async () => {
    const x = await tag('tagX00000001', 'tag', 'job')
    const y = await tag('tagY00000001', 'tag', 'work')
    const a = await tag('tagA00000001', 'tag', 'a')
    const t = await transaction({ tags: [y, a, x] })
    const acc = await account('acc000000001', { tags: [x, a, y] })

    await redirect(x, y)

    expect((await row('transactions', 'id', t)).tags).toBe(JSON.stringify([y, a]))
    expect((await row('accounts', 'id', acc)).tags).toBe(JSON.stringify([y, a]))
  })

  it('sums parts of the merged categories', async () => {
    const wallet = await account('wallet000001')
    const drinks = await tag('drinks000001', 'category', 'Drinks')
    const everyday = await tag('everyday0001', 'category', 'Everyday food')
    const groceries = await tag('groceries001', 'category', 'Groceries')
    // 9 € paid as 9.00 USD on the other side; Everyday food's to-side was
    // split at another scale, so the sum must stay exact across scales.
    const id = await transaction({
      from: wallet,
      amountFrom: [900, 2, 'EUR'],
      amountTo: [900, 2, 'USD'],
      categories: [
        [drinks, 100, 2, 100, 2],
        [everyday, 500, 2, 5000, 3],
        [groceries, 300, 2, 300, 2],
      ],
    })

    await redirect(everyday, groceries)

    const t = (await new TransactionsRepository(db).findById(asUuid(id)))!
    expect(t.categories).toEqual([
      {
        category_id: drinks,
        amount__from: moneyAmount(100, 2, 'EUR'),
        amount__to: moneyAmount(100, 2, 'USD'),
      },
      {
        category_id: groceries,
        amount__from: moneyAmount(800, 2, 'EUR'),
        amount__to: moneyAmount(8000, 3, 'USD'),
      },
    ])
    // Still a valid transaction: each category once, both sides adding up.
    await expect(assertTransactionRules(db, t, t)).resolves.toBeUndefined()
  })

  it('bumps updated_at_utc of rewritten rows', async () => {
    const x = await tag('tagX00000001', 'tag', 'job')
    const y = await tag('tagY00000001', 'tag', 'work')
    const a = await tag('tagA00000001', 'tag', 'a')
    const merchantX = await tag('merchX000001', 'merchant', 'X')
    const merchantY = await tag('merchY000001', 'merchant', 'Y')
    const child = await tag('child0000001', 'merchant', 'X Express', { parent: merchantX })
    const store = await tag('store0000001', 'location', 'X store')
    await db.run(
      `INSERT INTO location_details (tag_id, merchant_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?)`,
      [store, merchantX, AT, AT],
    )
    const tagged = await transaction({ tags: [x] })
    const bought = await transaction({ merchant: merchantX })
    const untouched = await transaction({ tags: [a] })
    const taggedAccount = await account('acc000000001', { tags: [x] })
    const otherAccount = await account('acc000000002', { tags: [a] })

    await db.transaction(async (tx) => {
      await redirectTagReferences(tx, x, y, { bump: true, now: NOW })
      await redirectTagReferences(tx, merchantX, merchantY, { bump: true, now: NOW })
    })

    const updatedAt = async (table: string, key: string, id: string) =>
      (await row(table, key, id)).updated_at_utc
    expect(await updatedAt('transactions', 'id', tagged)).toBe(NOW)
    expect(await updatedAt('transactions', 'id', bought)).toBe(NOW)
    expect(await updatedAt('accounts', 'id', taggedAccount)).toBe(NOW)
    expect(await updatedAt('tags', 'id', child)).toBe(NOW)
    expect(await updatedAt('location_details', 'tag_id', store)).toBe(NOW)
    // Rows that did not change keep their timestamps.
    expect(await updatedAt('transactions', 'id', untouched)).toBe(AT)
    expect(await updatedAt('accounts', 'id', otherAccount)).toBe(AT)
    expect(await updatedAt('tags', 'id', merchantY)).toBe(AT)
  })

  it('leaves timestamps alone without bump', async () => {
    const x = await tag('tagX00000001', 'tag', 'job')
    const y = await tag('tagY00000001', 'tag', 'work')
    const child = await tag('child0000001', 'tag', 'job/remote', { parent: x })
    const t = await transaction({ tags: [x] })
    const acc = await account('acc000000001', { tags: [x] })

    await redirect(x, y, false)

    expect(await row('transactions', 'id', t)).toMatchObject({
      tags: JSON.stringify([y]),
      updated_at_utc: AT,
    })
    expect(await row('accounts', 'id', acc)).toMatchObject({
      tags: JSON.stringify([y]),
      updated_at_utc: AT,
    })
    expect(await row('tags', 'id', child)).toMatchObject({ parent_id: y, updated_at_utc: AT })
  })

  it('never puts the target under itself', async () => {
    // Sync can combine "Y moved under X" from one device with "X merged into
    // Y" from another; the target keeps its parent for the sync repair.
    const x = await tag('tagX00000001', 'tag', 'X')
    const y = await tag('tagY00000001', 'tag', 'Y', { parent: x })
    const sibling = await tag('tagZ00000001', 'tag', 'Z', { parent: x })

    await redirect(x, y)

    expect(await row('tags', 'id', y)).toMatchObject({ parent_id: x })
    expect(await row('tags', 'id', sibling)).toMatchObject({ parent_id: y })
  })

  it('counts live transactions and accounts using a tag, each once', async () => {
    const x = await tag('tagX00000001', 'tag', 'X')
    const unused = await tag('tagU00000001', 'tag', 'unused')
    const cat = await tag('cat000000001', 'category', 'Food')
    await transaction({ tags: [x] })
    await transaction({ merchant: x, location: x, journey: x, tags: [x, x] })
    await transaction({ categories: [[x, 100, 2, 100, 2]] })
    await transaction({ categories: [[cat, 100, 2, 100, 2]] })
    await transaction({ tags: [x], deleted: true })
    await account('acc000000001', { tags: [x] })
    await account('acc000000002', { location: x, tags: [x] })
    await account('acc000000003', { tags: [x], deleted: true })

    expect(await countTagUsage(db, x)).toBe(5)
    expect(await countTagUsage(db, cat)).toBe(1)
    expect(await countTagUsage(db, unused)).toBe(0)
  })

  it('counts past malformed tags and categories values', async () => {
    const cat = await tag('cat000000001', 'category', 'Food')
    await transaction({ categories: [[cat, 100, 2, 100, 2]] })
    // Valid JSON, but not the lists the columns should hold.
    const malformed = [
      ['tags', JSON.stringify({ first: cat })],
      ['categories', JSON.stringify([cat])],
      ['categories', JSON.stringify({ category_id: cat })],
    ]
    for (const [column, value] of malformed) {
      const id = await transaction({})
      await db.run(`UPDATE transactions SET ${column} = ? WHERE id = ?`, [value, id])
    }
    await account('acc000000001')
    await db.run(`UPDATE accounts SET tags = ? WHERE id = 'acc000000001'`, [
      JSON.stringify({ first: cat }),
    ])

    expect(await countTagUsage(db, cat)).toBe(1)
  })
})
