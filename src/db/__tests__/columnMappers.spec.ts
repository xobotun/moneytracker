import { describe, it, expect } from 'vitest'
import { moneyAmount } from '../MoneyAmount'
import { localMoment } from '../LocalMoment'
import {
  moneyToColumns,
  moneyFromRow,
  localMomentToColumns,
  localMomentFromRow,
  jsonArrayToColumn,
  jsonArrayFromColumn,
  jsonObjectToColumn,
  jsonObjectFromColumn,
} from '../columnMappers'

describe('moneyToColumns / moneyFromRow', () => {
  it('flattens a MoneyAmount into prefixed columns', () => {
    expect(moneyToColumns('balance', moneyAmount(1234, 2, 'USD'))).toEqual({
      balance_value: 1234,
      balance_scale: 2,
      balance_currency: 'USD',
    })
  })

  it('reads back a MoneyAmount from a row', () => {
    const row = { balance_value: 1234, balance_scale: 2, balance_currency: 'USD', other: 'ignored' }
    expect(moneyFromRow('balance', row)).toEqual(moneyAmount(1234, 2, 'USD'))
  })

  it('round-trips a discriminated prefix (amount__from)', () => {
    const m = moneyAmount(50000000, 8, 'BTC')
    const cols = moneyToColumns('amount__from', m)
    expect(cols).toEqual({
      'amount_value__from': 50000000,
      'amount_scale__from': 8,
      'amount_currency__from': 'BTC',
    })
    expect(moneyFromRow('amount__from', cols)).toEqual(m)
  })
})

describe('localMomentToColumns / localMomentFromRow', () => {
  it('flattens and reads back a LocalMoment', () => {
    const lm = localMoment('2013-10-07T04:23:19.120+04:00', 'Europe/Berlin')
    const cols = localMomentToColumns('transaction_at', lm)
    expect(cols).toEqual({
      transaction_at_local: '2013-10-07T04:23:19.120+04:00',
      transaction_at_zone: 'Europe/Berlin',
    })
    expect(localMomentFromRow('transaction_at', cols)).toEqual(lm)
  })

  it('returns null from a row when both columns are null (nullable LocalMoment)', () => {
    expect(localMomentFromRow('date_override', { date_override_local: null, date_override_zone: null })).toBeNull()
  })

  it('throws if only one of local/zone is null (corrupt row)', () => {
    expect(() => localMomentFromRow('date_override', { date_override_local: 'x', date_override_zone: null })).toThrow()
  })

  it('flattens null LocalMoment to two nulls', () => {
    expect(localMomentToColumns('date_override', null)).toEqual({
      date_override_local: null,
      date_override_zone: null,
    })
  })
})

describe('jsonArrayToColumn / jsonArrayFromColumn', () => {
  it('stringifies a string array', () => {
    expect(jsonArrayToColumn(['a', 'b'])).toBe('["a","b"]')
  })

  it('stringifies an empty array', () => {
    expect(jsonArrayToColumn([])).toBe('[]')
  })

  it('parses back a string array', () => {
    expect(jsonArrayFromColumn('["a","b"]')).toEqual(['a', 'b'])
  })

  it('throws on malformed JSON (should have been caught by CHECK json_valid)', () => {
    expect(() => jsonArrayFromColumn('not json')).toThrow()
  })

  it('throws if the parsed value is not an array', () => {
    expect(() => jsonArrayFromColumn('{"a":1}')).toThrow()
  })
})

describe('jsonObjectToColumn / jsonObjectFromColumn', () => {
  it('round-trips an exchange-rates map', () => {
    const rates = { AED: 3.67, EUR: 0.92 }
    expect(jsonObjectFromColumn<number>(jsonObjectToColumn(rates))).toEqual(rates)
  })

  it('throws if the parsed value is not an object', () => {
    expect(() => jsonObjectFromColumn('[1,2,3]')).toThrow()
  })
})
