import { describe, it, expect } from 'vitest'
import { SYNC_TABLES } from '../syncTables'

describe('SYNC_TABLES', () => {
  it('lists every domain table exactly once', () => {
    const names = SYNC_TABLES.map((t) => t.name)
    expect(new Set(names)).toEqual(
      new Set([
        'locations',
        'tags',
        'exchange_rates',
        'account_groupings',
        'accounts',
        'transactions',
      ]),
    )
    expect(names).toHaveLength(6)
  })

  it('orders foreign-key parents before their children', () => {
    const order = SYNC_TABLES.map((t) => t.name)
    // accounts reference locations and account_groupings; transactions
    // reference accounts and locations.
    expect(order.indexOf('locations')).toBeLessThan(order.indexOf('accounts'))
    expect(order.indexOf('account_groupings')).toBeLessThan(order.indexOf('accounts'))
    expect(order.indexOf('accounts')).toBeLessThan(order.indexOf('transactions'))
    expect(order.indexOf('locations')).toBeLessThan(order.indexOf('transactions'))
  })

  it('uses "tag" as the primary key for the tags table and "id" elsewhere', () => {
    const byName = Object.fromEntries(SYNC_TABLES.map((t) => [t.name, t.pk]))
    expect(byName.tags).toBe('tag')
    expect(byName.accounts).toBe('id')
    expect(byName.transactions).toBe('id')
  })
})
