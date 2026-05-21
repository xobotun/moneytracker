import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainSchemaMigration } from '../../migrations/002_domain_schema'
import { TransactionsRepository } from '../TransactionsRepository'
import { newId, asUuid, type UUID } from '../../uuid'
import { moneyAmount } from '../../MoneyAmount'
import { localMoment } from '../../LocalMoment'

describe('TransactionsRepository', () => {
  let db: Database
  let repo: TransactionsRepository
  let accountId1: UUID
  let accountId2: UUID
  let locationId: UUID

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainSchemaMigration])
    repo = new TransactionsRepository(db)

    // Seed test data: two accounts and one location
    accountId1 = newId()
    accountId2 = newId()
    locationId = newId()
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
      `INSERT INTO locations (id, name, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?)`,
      [locationId, 'Test Location', now, now],
    )
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates and retrieves a normal transfer (both account_id__* set)', async () => {
    const input = {
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(10000, 2, 'USD'),
      amount__to: moneyAmount(9500, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: ['travel', 'business'],
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
    expect(created.tags).toEqual(['travel', 'business'])
    expect(created.created_at_utc).toBeDefined()
    expect(created.updated_at_utc).toBeDefined()
    expect(created.deleted_at_utc).toBeNull()

    const found = await repo.findById(created.id)
    expect(found).toEqual(created)
  })

  it('creates and retrieves income from Global Economy (account_id__from IS NULL)', async () => {
    const input = {
      account_id__from: null,
      account_id__to: asUuid(accountId1),
      amount__from: moneyAmount(5000, 2, 'USD'),
      amount__to: moneyAmount(5000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T10:00:00.000+00:00', 'UTC'),
      date_override: null,
      tags: ['salary'],
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
      account_id__from: asUuid(accountId1),
      account_id__to: null,
      amount__from: moneyAmount(2000, 2, 'USD'),
      amount__to: moneyAmount(2000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T12:00:00.000+00:00', 'UTC'),
      date_override: null,
      tags: ['groceries'],
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
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: dateOverride,
      tags: [],
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
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(500, 2, 'USD'),
      amount__to: moneyAmount(475, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
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
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(800, 2, 'USD'),
      amount__to: moneyAmount(760, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      location_lat: null,
      location_lon: null,
      location_id: asUuid(locationId),
    }

    const created = await repo.create(input)

    expect(created.location_id).toBe(locationId)

    const found = await repo.findById(created.id)
    expect(found?.location_id).toBe(locationId)
  })

  it('throws on FK violation: bad account_id__from', async () => {
    const input = {
      account_id__from: asUuid('nonexistent-account-id'),
      account_id__to: accountId1,
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(1000, 2, 'USD'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    await expect(repo.create(input)).rejects.toThrow()
  })

  it('throws on FK violation: bad location_id', async () => {
    const input = {
      account_id__from: accountId1,
      account_id__to: accountId2,
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
      location_lat: null,
      location_lon: null,
      location_id: asUuid('nonexistent-location-id'),
    }

    await expect(repo.create(input)).rejects.toThrow()
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
        id1, accountId1, accountId2,
        1000, 2, 'USD', 950, 2, 'EUR',
        '2026-03-15T14:30:00.000+00:00', 'UTC',
        '[]', now, now,
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
        id2, accountId1, accountId2,
        500, 2, 'USD', 475, 2, 'EUR',
        '2026-03-16T14:30:00.000+00:00', 'UTC',
        '[]', now, now, now,
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
        id1, accountId1, accountId2,
        1000, 2, 'USD', 950, 2, 'EUR',
        '2026-03-15T14:30:00.000+00:00', 'UTC',
        '[]', now, now,
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
        id2, null, accountId1,
        5000, 2, 'USD', 5000, 2, 'USD',
        '2026-03-16T10:00:00.000+00:00', 'UTC',
        '[]', now, now,
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
        id3, accountId1, null,
        2000, 2, 'USD', 2000, 2, 'USD',
        '2026-03-17T12:00:00.000+00:00', 'UTC',
        '[]', now, now, now,
      ],
    )

    const transactions = await repo.listByAccountId(asUuid(accountId1))
    expect(transactions.length).toBe(2)
    expect(transactions.map(t => t.id)).toContain(id1)
    expect(transactions.map(t => t.id)).toContain(id2)
    expect(transactions.map(t => t.id)).not.toContain(id3)
  })

  it('findById returns null for soft-deleted transaction', async () => {
    const input = {
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: [],
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
    const input = {
      account_id__from: asUuid(accountId1),
      account_id__to: asUuid(accountId2),
      amount__from: moneyAmount(1000, 2, 'USD'),
      amount__to: moneyAmount(950, 2, 'EUR'),
      transaction_at: localMoment('2026-03-15T14:30:00.000+00:00', 'UTC'),
      date_override: null,
      tags: ['original'],
      location_lat: null,
      location_lon: null,
      location_id: null,
    }

    const created = await repo.create(input)
    const originalUpdatedAt = created.updated_at_utc

    // Small delay to ensure timestamp changes
    await new Promise(resolve => setTimeout(resolve, 2))

    // Update tags and amount
    await repo.update(created.id, {
      tags: ['updated', 'modified'],
      amount__from: moneyAmount(2000, 2, 'USD'),
    })

    const updated = await repo.findById(created.id)
    expect(updated).not.toBeNull()
    expect(updated!.tags).toEqual(['updated', 'modified'])
    expect(updated!.amount__from).toEqual(moneyAmount(2000, 2, 'USD'))
    expect(updated!.amount__to).toEqual(moneyAmount(950, 2, 'EUR')) // unchanged
    expect(updated!.updated_at_utc).not.toBe(originalUpdatedAt)
  })
})
