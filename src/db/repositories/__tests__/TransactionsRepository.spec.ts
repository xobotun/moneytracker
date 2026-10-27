import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainSchemaMigration } from '../../migrations/002_domain_schema'
import { TransactionsRepository, TRANSACTION_ORDER_BY } from '../TransactionsRepository'
import { AccountsRepository } from '../AccountsRepository'
import { TagsRepository } from '../TagsRepository'
import { newId } from '../../uuid'
import { moneyAmount, zeroMoney, type MoneyAmount } from '../../MoneyAmount'
import { localMoment } from '../../LocalMoment'
import { newShortId, asShortId, type ShortId } from '../../shortId'
import {
  CurrencyMismatchError,
  DeletedTagError,
  DuplicateReferenceError,
  NoCategoryError,
  PartsSumError,
  TagKindMismatchError,
  TagNotFoundError,
} from '../../errors'
import type { Account, CategoryPart, Tag } from '../../types'

describe('TransactionsRepository', () => {
  let db: Database
  let repo: TransactionsRepository
  let accountId1: ShortId
  let accountId2: ShortId
  let locationId: ShortId
  let categoryId: ShortId

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainSchemaMigration])
    repo = new TransactionsRepository(db)

    // Seed test data: two accounts and one location tag
    accountId1 = newShortId()
    accountId2 = newShortId()
    locationId = newShortId()
    const now = new Date().toISOString()

    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId1, 'Account 1', 'USD', 0, 2, '#FF0000', 'icon-1', now, now],
    )

    await db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId2, 'Account 2', 'EUR', 0, 2, '#00FF00', 'icon-2', now, now],
    )

    await db.run(
      `INSERT INTO tags (id, kind, name, moved_at_utc, created_at_utc, updated_at_utc)
       VALUES (?, 'location', ?, ?, ?, ?)`,
      [locationId, 'Test Location', now, now, now],
    )

    // Every transaction needs a category.
    categoryId = (await new TagsRepository(db).create({ kind: 'category', name: 'Misc' })).id
  })

  /** One part holding the whole of both amounts, in the test category. */
  const whole = (amount__from: MoneyAmount, amount__to: MoneyAmount): CategoryPart[] => [
    { category_id: categoryId, amount__from, amount__to },
  ]

  /** Live plain tags with these names, by id. */
  const plainTags = async (...names: string[]) => {
    const tags = new TagsRepository(db)
    return Promise.all(names.map(async (name) => (await tags.create({ kind: 'tag', name })).id))
  }

  afterEach(async () => {
    await db.close()
  })

  it('creates and retrieves a normal transfer (both account_id__* set)', async () => {
    const [travel, business] = await plainTags('travel', 'business')
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(10000, 2, 'USD'),
      amount__to: moneyAmount(9500, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [travel!, business!],
      categories: whole(moneyAmount(10000, 2, 'USD'), moneyAmount(9500, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)

    expect(created.id).toBeDefined()
    expect(created.account_id__from).toBe(accountId1)
    expect(created.account_id__to).toBe(accountId2)
    expect(created.amount__from).toEqual(moneyAmount(10000, 2, 'USD'))
    expect(created.amount__to).toEqual(moneyAmount(9500, 2, 'EUR'))
    expect(created.transaction_at).toEqual(localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'))
    expect(created.date_override).toBeNull()
    expect(created.tags).toEqual([travel, business])
    expect(created.categories).toEqual(
      whole(moneyAmount(10000, 2, 'USD'), moneyAmount(9500, 2, 'EUR')),
    )
    expect(created.created_at_utc).toBeDefined()
    expect(created.updated_at_utc).toBeDefined()
    expect(created.deleted_at_utc).toBeNull()

    const found = await repo.findById(created.id)
    expect(found).toEqual(created)
  })

  it('creates and retrieves income from Global Economy (account_id__from IS NULL)', async () => {
    const input = {
      account_id__from: null,
      account_id__to: asShortId(accountId1),
      amount__from: moneyAmount(5000, 2, 'USD'),
      amount__to: moneyAmount(5000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T10:00:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(5000, 2, 'USD'), moneyAmount(5000, 2, 'USD')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)

    expect(created.account_id__from).toBeNull()
    expect(created.account_id__to).toBe(accountId1)

    const found = await repo.findById(created.id)
    expect(found).toEqual(created)
  })

  it('creates and retrieves spend into Global Economy (account_id__to IS NULL)', async () => {
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: null,
      amount__from: moneyAmount(2000, 2, 'USD'),
      amount__to: moneyAmount(2000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T12:00:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(2000, 2, 'USD'), moneyAmount(2000, 2, 'USD')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)

    expect(created.account_id__from).toBe(accountId1)
    expect(created.account_id__to).toBeNull()

    const found = await repo.findById(created.id)
    expect(found).toEqual(created)
  })

  it('creates and retrieves a transaction with date_override set', async () => {
    const dateOverride = localMoment('2026-02-28T23:59:59.999+00:00', 'UTC')
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: dateOverride,
      tags: [],
      categories: whole(moneyAmount(1000, 2, 'USD'), moneyAmount(950, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)

    expect(created.date_override).toEqual(dateOverride)

    const found = await repo.findById(created.id)
    expect(found?.date_override).toEqual(dateOverride)
  })

  it('creates and retrieves a transaction with location_lat/location_lon only', async () => {
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(500, 2, 'USD'),
      amount__to: moneyAmount(475, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(500, 2, 'USD'), moneyAmount(475, 2, 'EUR')),
      location_lat: 51.5074,
      location_lon: -0.1278,
      location_id: null,
    }

    const created = await repo.create(input)

    expect(created.location_lat).toBe(51.5074)
    expect(created.location_lon).toBe(-0.1278)
    expect(created.location_id).toBeNull()

    const found = await repo.findById(created.id)
    expect(found?.location_lat).toBe(51.5074)
    expect(found?.location_lon).toBe(-0.1278)
    expect(found?.location_id).toBeNull()
  })

  it('creates and retrieves a transaction with location_id set', async () => {
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(800, 2, 'USD'),
      amount__to: moneyAmount(760, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(800, 2, 'USD'), moneyAmount(760, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: locationId,
    }

    const created = await repo.create(input)

    expect(created.location_id).toBe(locationId)

    const found = await repo.findById(created.id)
    expect(found?.location_id).toBe(locationId)
  })

  it('throws on FK violation: bad account_id__from', async () => {
    const input = {
      account_id__from: asShortId('nonexistent-account-id'),
      account_id__to: accountId1,
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(1000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(1000, 2, 'USD'), moneyAmount(1000, 2, 'USD')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    await expect(repo.create(input)).rejects.toThrow()
  })

  it('rejects a location_id that is no tag', async () => {
    const input = {
      account_id__from: accountId1,
      account_id__to: accountId2,
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(1000, 2, 'USD'), moneyAmount(950, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: asShortId('nonexistent-location-id'),
    }

    await expect(repo.create(input)).rejects.toThrow(/Location: tag .* not found/)
  })

  it('list() returns non-deleted transactions only', async () => {
    const id1 = newId()
    const id2 = newId()
    const now = new Date().toISOString()

    await db.run(
      `INSERT INTO transactions (
        id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        tags, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id1,
        accountId1,
        accountId2,
        1000,
        2,
        'USD',
        950,
        2,
        'EUR',
        '2026-03-15T14:30:00.000+00:00',
        'UTC',
        '[]',
        now,
        now,
      ],
    )

    await db.run(
      `INSERT INTO transactions (
        id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        tags, created_at_utc, updated_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id2,
        accountId1,
        accountId2,
        500,
        2,
        'USD',
        475,
        2,
        'EUR',
        '2026-03-16T14:30:00.000+00:00',
        'UTC',
        '[]',
        now,
        now,
        now,
      ],
    )

    const transactions = await repo.list()
    expect(transactions.length).toBe(1)
    expect(transactions[0]!.id).toBe(id1)
  })

  it('listByAccountId returns transactions on either leg, excludes soft-deleted', async () => {
    const id1 = newId()
    const id2 = newId()
    const id3 = newId()
    const now = new Date().toISOString()

    // Transaction from accountId1 to accountId2
    await db.run(
      `INSERT INTO transactions (
        id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        tags, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id1,
        accountId1,
        accountId2,
        1000,
        2,
        'USD',
        950,
        2,
        'EUR',
        '2026-03-15T14:30:00.000+00:00',
        'UTC',
        '[]',
        now,
        now,
      ],
    )

    // Transaction to accountId1 (from null / income)
    await db.run(
      `INSERT INTO transactions (
        id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        tags, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id2,
        null,
        accountId1,
        5000,
        2,
        'USD',
        5000,
        2,
        'USD',
        '2026-03-16T10:00:00.000+00:00',
        'UTC',
        '[]',
        now,
        now,
      ],
    )

    // Soft-deleted transaction involving accountId1
    await db.run(
      `INSERT INTO transactions (
        id, account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        tags, created_at_utc, updated_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id3,
        accountId1,
        null,
        2000,
        2,
        'USD',
        2000,
        2,
        'USD',
        '2026-03-17T12:00:00.000+00:00',
        'UTC',
        '[]',
        now,
        now,
        now,
      ],
    )

    const transactions = await repo.listByAccountId(asShortId(accountId1))
    expect(transactions.length).toBe(2)
    expect(transactions.map((t) => t.id)).toContain(id1)
    expect(transactions.map((t) => t.id)).toContain(id2)
    expect(transactions.map((t) => t.id)).not.toContain(id3)
  })

  it('findById returns null for soft-deleted transaction', async () => {
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(1000, 2, 'USD'), moneyAmount(950, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)
    await repo.softDelete(created.id)

    const found = await repo.findById(created.id)
    expect(found).toBeNull()
  })

  it('updates a transaction', async () => {
    const [original, updatedTag, modified] = await plainTags('original', 'updated', 'modified')
    const input = {
      account_id__from: asShortId(accountId1),
      account_id__to: asShortId(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [original!],
      categories: whole(moneyAmount(1000, 2, 'USD'), moneyAmount(950, 2, 'EUR')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)
    const originalUpdatedAt = created.updated_at_utc

    // Small delay to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 2))

    // Update tags and amount (the parts follow the new amount)
    await repo.update(created.id, {
      tags: [updatedTag!, modified!],
      amount__from: moneyAmount(2000, 2, 'USD'),
      categories: whole(moneyAmount(2000, 2, 'USD'), moneyAmount(950, 2, 'EUR')),
    })

    const updated = await repo.findById(created.id)
    expect(updated).not.toBeNull()
    expect(updated!.tags).toEqual([updatedTag, modified])
    expect(updated!.amount__from).toEqual(moneyAmount(2000, 2, 'USD'))
    expect(updated!.amount__to).toEqual(moneyAmount(950, 2, 'EUR')) // unchanged
    // Compare instants: `.not.toBe` on two Date objects compares identity and always passes.
    expect(updated!.updated_at_utc.getTime()).toBeGreaterThan(originalUpdatedAt.getTime())
  })

  describe('descriptions', () => {
    const input = () => ({
      account_id__from: asShortId(accountId1),
      account_id__to: null,
      amount__from: moneyAmount(350, 2, 'USD'),
      amount__to: moneyAmount(350, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      categories: whole(moneyAmount(350, 2, 'USD'), moneyAmount(350, 2, 'USD')),
      location_lat: null,
      location_lon: null,
      location_id: null,
    })

    it('default to null when not given', async () => {
      const created = await repo.create(input())
      expect(created.description__user).toBeNull()
      expect(created.description__auto).toBeNull()
    })

    it('round-trip the user note and the imported object', async () => {
      const auto = { source: 'ocr', raw: 'KAFFEE 3,50\n"Bar" am Markt', confidence: 0.93 }
      const created = await repo.create({
        ...input(),
        description__user: 'Coffee with Anna, "the usual"',
        description__auto: auto,
      })
      const found = await repo.findById(created.id)
      expect(found?.description__user).toBe('Coffee with Anna, "the usual"')
      expect(found?.description__auto).toEqual(auto)
    })

    it('store an empty user note as null', async () => {
      const created = await repo.create({
        ...input(),
        description__user: '',
      })
      expect(created.description__user).toBeNull()
    })

    it('are updated and cleared', async () => {
      const created = await repo.create({
        ...input(),
        description__user: 'before',
        description__auto: { source: 'bank-api' },
      })
      await repo.update(created.id, { description__user: 'after' })
      expect((await repo.findById(created.id))?.description__user).toBe('after')
      expect((await repo.findById(created.id))?.description__auto).toEqual({ source: 'bank-api' })

      await repo.update(created.id, { description__user: '', description__auto: null })
      const cleared = await repo.findById(created.id)
      expect(cleared?.description__user).toBeNull()
      expect(cleared?.description__auto).toBeNull()
    })
  })

  describe('ordering', () => {
    function inputAt(local: string, zone: string, override: [string, string] | null = null) {
      return {
        account_id__from: accountId1,
        account_id__to: null,
        amount__from: moneyAmount(100, 2, 'USD'),
        amount__to: moneyAmount(100, 2, 'USD'),
        transaction_at: localMoment(local, zone),
        date_override: override === null ? null : localMoment(override[0], override[1]),
        tags: [],
        categories: whole(moneyAmount(100, 2, 'USD'), moneyAmount(100, 2, 'USD')),
        location_lat: null,
        location_lon: null,
        location_id: null,
      }
    }

    it('list() sorts by the real instant across UTC offsets, newest first', async () => {
      // 10:00+04:00 is 06:00Z; 09:00+00:00 is 09:00Z — later despite the smaller wall-clock text.
      const earlier = await repo.create(inputAt('2026-01-01T10:00:00.000+04:00', 'Asia/Dubai'))
      const later = await repo.create(inputAt('2026-01-01T09:00:00.000+00:00', 'UTC'))

      const ids = (await repo.list()).map((t) => t.id)
      expect(ids).toEqual([later.id, earlier.id])
    })

    it("list('effective') sorts by date_override when set, else transaction_at", async () => {
      const plain = await repo.create(inputAt('2026-01-02T12:00:00.000+00:00', 'UTC'))
      const overridden = await repo.create(
        inputAt('2026-01-01T12:00:00.000+00:00', 'UTC', ['2026-01-03T12:00:00.000+00:00', 'UTC']),
      )

      expect((await repo.list('transaction_at')).map((t) => t.id)).toEqual([
        plain.id,
        overridden.id,
      ])
      expect((await repo.list('effective')).map((t) => t.id)).toEqual([overridden.id, plain.id])
    })

    it('listByAccountId honours the sort mode', async () => {
      const plain = await repo.create(inputAt('2026-01-02T12:00:00.000+00:00', 'UTC'))
      const overridden = await repo.create(
        inputAt('2026-01-01T12:00:00.000+00:00', 'UTC', ['2026-01-03T12:00:00.000+00:00', 'UTC']),
      )

      expect((await repo.listByAccountId(accountId1)).map((t) => t.id)).toEqual([
        plain.id,
        overridden.id,
      ])
      expect((await repo.listByAccountId(accountId1, 'effective')).map((t) => t.id)).toEqual([
        overridden.id,
        plain.id,
      ])
    })

    it('breaks ties on the same instant by id, newest id first', async () => {
      // Same instant (12:00Z); the text of `first` sorts higher, so only the id tie-break orders them.
      const first = await repo.create(inputAt('2026-01-01T14:00:00.000+02:00', 'Europe/Berlin'))
      const second = await repo.create(inputAt('2026-01-01T12:00:00.000+00:00', 'UTC'))

      expect((await repo.list()).map((t) => t.id)).toEqual([second.id, first.id])
    })

    it.each([
      ['transaction_at', 'idx_transactions_at'],
      ['effective', 'idx_transactions_effective_at'],
    ] as const)("the '%s' ordering is served by %s", async (mode, indexName) => {
      const plan = await db.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE deleted_at_utc IS NULL ORDER BY ${TRANSACTION_ORDER_BY[mode]}`,
      )
      expect(plan.map((r) => r.detail).join('\n')).toContain(indexName)
    })
  })

  describe('cached account balances', () => {
    // Account 1 is in USD, Account 2 in EUR.
    const balance = async (id: ShortId) =>
      (
        await db.exec<{ v: number; s: number }>(
          'SELECT balance_value AS v, balance_scale AS s FROM accounts WHERE id = ?',
          [id],
        )
      )[0]!

    function input(from: ShortId | null, to: ShortId | null, usd: number, eur: number) {
      return {
        account_id__from: from,
        account_id__to: to,
        amount__from: moneyAmount(usd, 2, 'USD'),
        amount__to: moneyAmount(eur, 2, 'EUR'),
        transaction_at: localMoment('2026-10-25T12:00:00.000+02:00', 'Europe/Berlin'),
        date_override: null,
        tags: [],
        categories: whole(moneyAmount(usd, 2, 'USD'), moneyAmount(eur, 2, 'EUR')),
        location_lat: null,
        location_lon: null,
        location_id: null,
      }
    }

    it('create() updates both accounts of a transfer', async () => {
      await repo.create(input(accountId1, accountId2, 1000, 920))
      expect(await balance(accountId1)).toEqual({ v: -1000, s: 2 })
      expect(await balance(accountId2)).toEqual({ v: 920, s: 2 })
    })

    it('update() refreshes the account a leg left and the one it moved to', async () => {
      const t = await repo.create(input(null, accountId2, 0, 500)) // income to Account 2
      await repo.update(t.id, {
        account_id__to: accountId1,
        amount__to: moneyAmount(550, 2, 'USD'),
        categories: whole(moneyAmount(0, 2, 'USD'), moneyAmount(550, 2, 'USD')),
      })
      expect(await balance(accountId2)).toEqual({ v: 0, s: 2 })
      expect(await balance(accountId1)).toEqual({ v: 550, s: 2 })
    })

    it('countByAccountId() counts live transactions on either leg', async () => {
      await repo.create(input(accountId1, accountId2, 100, 90))
      await repo.create(input(null, accountId2, 0, 50))
      const gone = await repo.create(input(accountId1, null, 10, 0))
      await repo.softDelete(gone.id)
      expect(await repo.countByAccountId(accountId1)).toBe(1)
      expect(await repo.countByAccountId(accountId2)).toBe(2)
    })

    it('softDelete() takes the transaction out of the balance', async () => {
      const t = await repo.create(input(accountId1, null, 300, 0))
      expect((await balance(accountId1)).v).toBe(-300)
      await repo.softDelete(t.id)
      expect((await balance(accountId1)).v).toBe(0)
    })
  })

  describe('category parts and tag references', () => {
    let tags: TagsRepository
    let account: Account
    let groceries: Tag
    let gifts: Tag

    beforeEach(async () => {
      tags = new TagsRepository(db)
      account = await new AccountsRepository(db).create({
        name: 'Revolut',
        balance: zeroMoney('EUR'),
        tags: [],
        location_id: null,
        grouping_id: null,
        colour: '#000000',
        icon: 'wallet',
      })
      groceries = await tags.create({ kind: 'category', name: 'Groceries' })
      gifts = await tags.create({ kind: 'category', name: 'Gifts' })
    })

    const eur = (value: number, scale = 2) => moneyAmount(value, scale, 'EUR')
    const amd = (value: number) => moneyAmount(value, 0, 'AMD')
    const part = (category: Tag, from: MoneyAmount, to: MoneyAmount): CategoryPart => ({
      category_id: category.id,
      amount__from: from,
      amount__to: to,
    })
    /** 2.01 € → 800 AMD in two equal parts, kept at extra precision (decisions §2.4). */
    const split = () => [
      part(groceries, eur(1005000, 6), amd(400)),
      part(gifts, eur(1005000, 6), amd(400)),
    ]
    /** The whole of the shop's amounts in Groceries. */
    const groceriesOnly = () => [part(groceries, eur(201), amd(800))]

    /** Paying 800 AMD in an Armenian shop with the EUR card: 2.01 €. */
    function shop(categories: CategoryPart[]) {
      return {
        account_id__from: account.id,
        account_id__to: null,
        amount__from: eur(201),
        amount__to: amd(800),
        transaction_at: localMoment('2026-10-26T12:00:00.000+04:00', 'Asia/Yerevan'),
        date_override: null,
        tags: [] as ShortId[],
        categories,
        location_lat: null,
        location_lon: null,
        location_id: null,
      }
    }

    it('requires at least one category', async () => {
      await expect(repo.create(shop([]))).rejects.toThrow(NoCategoryError)
      await expect(repo.create(shop([]))).rejects.toThrow(/at least one category/)
      expect(await repo.list()).toEqual([])

      const t = await repo.create(shop(split()))
      await expect(repo.update(t.id, { categories: [] })).rejects.toThrow(/at least one category/)
      expect((await repo.findById(t.id))!.categories).toEqual(split())
    })

    it('rejects the same category twice', async () => {
      const twice = [part(groceries, eur(100), amd(400)), part(groceries, eur(101), amd(400))]
      await expect(repo.create(shop(twice))).rejects.toThrow(DuplicateReferenceError)
      await expect(repo.create(shop(twice))).rejects.toThrow(/Groceries.*twice/)
    })

    it('rejects the same plain tag twice', async () => {
      const birthday = await tags.create({ kind: 'tag', name: 'birthday' })
      const twice = { ...shop(groceriesOnly()), tags: [birthday.id, birthday.id] }
      await expect(repo.create(twice)).rejects.toThrow(DuplicateReferenceError)
      await expect(repo.create(twice)).rejects.toThrow(/birthday.*twice/)

      const t = await repo.create({ ...shop(groceriesOnly()), tags: [birthday.id] })
      await expect(repo.update(t.id, { tags: [birthday.id, birthday.id] })).rejects.toThrow(
        /birthday.*twice/,
      )
      expect((await repo.findById(t.id))!.tags).toEqual([birthday.id])
    })

    it('rejects parts that do not add up', async () => {
      // From side: 1.00 € + 1.00 € is not 2.01 €.
      const fromShort = shop([part(groceries, eur(100), amd(400)), part(gifts, eur(100), amd(400))])
      await expect(repo.create(fromShort)).rejects.toThrow(PartsSumError)
      await expect(repo.create(fromShort)).rejects.toThrow(/from side .*2\.00 EUR.*2\.01 EUR/)

      // To side: 400 + 399 AMD is not 800 AMD; the from side is exact at another scale.
      const toShort = shop([
        part(groceries, eur(1005000, 6), amd(400)),
        part(gifts, eur(1005000, 6), amd(399)),
      ])
      await expect(repo.create(toShort)).rejects.toThrow(PartsSumError)
      await expect(repo.create(toShort)).rejects.toThrow(/to side .*799 AMD.*800 AMD/)
      expect(await repo.list()).toEqual([])

      // An update is checked as the row will be: a new total needs new parts.
      const t = await repo.create(shop(split()))
      await expect(repo.update(t.id, { amount__from: eur(221) })).rejects.toThrow(
        /from side .*2\.010000 EUR.*2\.21 EUR/,
      )
      expect((await repo.findById(t.id))!.amount__from).toEqual(eur(201))

      const step4 = [part(groceries, eur(55), amd(200)), part(gifts, eur(166), amd(600))]
      await repo.update(t.id, { amount__from: eur(221), categories: step4 })
      expect(await repo.findById(t.id)).toMatchObject({ amount__from: eur(221), categories: step4 })
    })

    it("rejects parts in another currency than the transaction's", async () => {
      const inUsd = [part(groceries, moneyAmount(201, 2, 'USD'), amd(800))]
      await expect(repo.create(shop(inUsd))).rejects.toThrow(CurrencyMismatchError)

      // A currency change needs parts in the new currency too.
      const t = await repo.create(shop(groceriesOnly()))
      await expect(repo.update(t.id, { amount__to: moneyAmount(201, 2, 'USD') })).rejects.toThrow(
        CurrencyMismatchError,
      )
    })

    it('stores parts at extra precision and reads them back', async () => {
      const created = await repo.create(shop(split()))

      expect(created.categories).toEqual(split())
      expect(created.categories[0]!.amount__from).toEqual(moneyAmount(1005000, 6, 'EUR'))
      expect(await repo.findById(created.id)).toEqual(created)

      const [row] = await db.exec<{ categories: string }>(
        'SELECT categories FROM transactions WHERE id = ?',
        [created.id],
      )
      expect(JSON.parse(row!.categories)).toEqual([
        {
          category_id: groceries.id,
          amount_value__from: 1005000,
          amount_scale__from: 6,
          amount_value__to: 400,
          amount_scale__to: 0,
        },
        {
          category_id: gifts.id,
          amount_value__from: 1005000,
          amount_scale__from: 6,
          amount_value__to: 400,
          amount_scale__to: 0,
        },
      ])
    })

    it('stores the merchant, the journey and plain tags', async () => {
      const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
      const armenia = await tags.create({ kind: 'journey', name: 'Armenia 2026' })
      const birthday = await tags.create({ kind: 'tag', name: 'birthday' })
      const mia = await tags.create({ kind: 'tag', name: 'mia' })

      const created = await repo.create({
        ...shop(split()),
        merchant_id: rewe.id,
        journey_id: armenia.id,
        tags: [birthday.id, mia.id],
      })
      expect(created).toMatchObject({
        merchant_id: rewe.id,
        journey_id: armenia.id,
        tags: [birthday.id, mia.id],
      })
      expect(await repo.findById(created.id)).toEqual(created)

      // Left out of create(): none.
      expect(await repo.create(shop(split()))).toMatchObject({
        merchant_id: null,
        journey_id: null,
      })

      await repo.update(created.id, { merchant_id: null, journey_id: null, tags: [mia.id] })
      expect(await repo.findById(created.id)).toMatchObject({
        merchant_id: null,
        journey_id: null,
        tags: [mia.id],
      })
    })

    it('rejects a merchant that is not a merchant', async () => {
      await expect(repo.create({ ...shop(split()), merchant_id: groceries.id })).rejects.toThrow(
        TagKindMismatchError,
      )

      const t = await repo.create(shop(split()))
      await expect(repo.update(t.id, { merchant_id: gifts.id })).rejects.toThrow(
        TagKindMismatchError,
      )
      expect((await repo.findById(t.id))!.merchant_id).toBeNull()
    })

    it('checks the kind of the categories, the location, the journey and the tags', async () => {
      const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
      const yerevan = await tags.create({ kind: 'location', name: 'Yerevan' })
      const armenia = await tags.create({ kind: 'journey', name: 'Armenia 2026' })

      const rejects = (input: Parameters<TransactionsRepository['create']>[0]) =>
        expect(repo.create(input)).rejects.toThrow(TagKindMismatchError)
      await rejects(shop([part(rewe, eur(201), amd(800))]))
      await rejects({ ...shop(split()), location_id: armenia.id })
      await rejects({ ...shop(split()), journey_id: yerevan.id })
      await rejects({ ...shop(split()), tags: [groceries.id] })

      await expect(
        repo.create({ ...shop(split()), tags: [asShortId('NoSuchTag123')] }),
      ).rejects.toThrow(TagNotFoundError)
      expect(await repo.list()).toEqual([])
    })

    it('keeps a deleted tag already on the transaction but refuses adding one', async () => {
      const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
      const birthday = await tags.create({ kind: 'tag', name: 'birthday' })
      const mia = await tags.create({ kind: 'tag', name: 'mia' })
      const tagged = await repo.create({
        ...shop(split()),
        merchant_id: rewe.id,
        tags: [birthday.id],
      })
      const bare = await repo.create(shop(groceriesOnly()))

      await tags.softDelete(rewe.id)
      await tags.softDelete(birthday.id)
      // A category in use is merged rather than deleted, but sync can still bring its deletion.
      await db.run('UPDATE tags SET deleted_at_utc = ? WHERE id = ?', [
        '2026-10-26T11:00:00.000Z',
        gifts.id,
      ])

      // The transaction keeps them through its edits...
      await repo.update(tagged.id, { description__user: 'still tagged' })
      const resplit = [part(groceries, eur(101), amd(500)), part(gifts, eur(100), amd(300))]
      await repo.update(tagged.id, { tags: [birthday.id, mia.id], categories: resplit })
      expect(await repo.findById(tagged.id)).toMatchObject({
        merchant_id: rewe.id,
        tags: [birthday.id, mia.id],
        categories: resplit,
      })

      // ...but nothing can newly reference them,
      await expect(repo.create({ ...shop(groceriesOnly()), merchant_id: rewe.id })).rejects.toThrow(
        /"Rewe" is deleted/,
      )
      await expect(repo.update(bare.id, { tags: [birthday.id] })).rejects.toThrow(DeletedTagError)
      await expect(repo.update(bare.id, { merchant_id: rewe.id })).rejects.toThrow(/deleted/)
      await expect(repo.update(bare.id, { categories: resplit })).rejects.toThrow(/deleted/)
      expect(await repo.findById(bare.id)).toMatchObject({
        merchant_id: null,
        tags: [],
        categories: groceriesOnly(),
      })

      // not even the transaction that dropped one.
      await repo.update(tagged.id, { tags: [mia.id] })
      await expect(repo.update(tagged.id, { tags: [mia.id, birthday.id] })).rejects.toThrow(
        /deleted/,
      )
    })

    it('refuses to update a transaction that does not exist', async () => {
      await expect(repo.update(newId(), { description__user: 'lost' })).rejects.toThrow(/not found/)
    })
  })
})
