import { describe, it, expect } from 'vitest'
import { SYNC_TABLES } from '../syncTables'

describe('SYNC_TABLES', () => {
  it('lists every synced domain table exactly once (exchange_rates stays on the device)', () => {
    const names = SYNC_TABLES.map((t) => t.name)
    expect(new Set(names)).toEqual(
      new Set([
        'tags',
        'location_details',
        'merchant_details',
        'journey_details',
        'applied_rates',
        'account_groupings',
        'accounts',
        'transactions',
      ]),
    )
    expect(names).toHaveLength(8)
  })

  it('orders foreign-key parents before their children', () => {
    const order = SYNC_TABLES.map((t) => t.name)
    // The side tables, accounts and transactions reference tags; accounts
    // reference account_groupings; transactions reference accounts.
    for (const child of ['location_details', 'merchant_details', 'journey_details']) {
      expect(order.indexOf('tags')).toBeLessThan(order.indexOf(child))
    }
    expect(order.indexOf('tags')).toBeLessThan(order.indexOf('accounts'))
    expect(order.indexOf('account_groupings')).toBeLessThan(order.indexOf('accounts'))
    expect(order.indexOf('accounts')).toBeLessThan(order.indexOf('transactions'))
    expect(order.indexOf('tags')).toBeLessThan(order.indexOf('transactions'))
  })

  it('keys the side tables by "tag_id" and every other table by "id"', () => {
    const byName = Object.fromEntries(SYNC_TABLES.map((t) => [t.name, t.pk]))
    expect(byName).toEqual({
      tags: 'id',
      location_details: 'tag_id',
      merchant_details: 'tag_id',
      journey_details: 'tag_id',
      applied_rates: 'id',
      account_groupings: 'id',
      accounts: 'id',
      transactions: 'id',
    })
  })
})
