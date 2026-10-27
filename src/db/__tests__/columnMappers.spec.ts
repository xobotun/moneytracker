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
  jsonObjectToNullableColumn,
  jsonObjectFromNullableColumn,
  booleanToColumn,
  booleanFromColumn,
  categoryPartsToColumn,
  categoryPartsFromColumn,
} from '../columnMappers'
import { asShortId } from '../shortId'

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
      amount_value__from: 50000000,
      amount_scale__from: 8,
      amount_currency__from: 'BTC',
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
    expect(
      localMomentFromRow('date_override', { date_override_local: null, date_override_zone: null }),
    ).toBeNull()
  })

  it('throws if only one of local/zone is null (corrupt row)', () => {
    expect(() =>
      localMomentFromRow('date_override', { date_override_local: 'x', date_override_zone: null }),
    ).toThrow()
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

describe('jsonObjectToNullableColumn / jsonObjectFromNullableColumn', () => {
  it('round-trips an object and keeps null as SQL NULL', () => {
    const auto = { source: 'ocr', raw: 'KAFFEE 3,50' }
    expect(jsonObjectFromNullableColumn(jsonObjectToNullableColumn(auto))).toEqual(auto)
    expect(jsonObjectToNullableColumn(null)).toBeNull()
    expect(jsonObjectFromNullableColumn(null)).toBeNull()
  })
})

describe('categoryPartsToColumn / categoryPartsFromColumn', () => {
  const groceries = asShortId('Groceries123')
  const gifts = asShortId('Gifts1234567')

  it('stores each part without its currencies, in the pinned shape and key order', () => {
    const text = categoryPartsToColumn([
      {
        category_id: groceries,
        amount__from: moneyAmount(1005000, 6, 'EUR'),
        amount__to: moneyAmount(400, 0, 'AMD'),
      },
    ])
    expect(text).toBe(
      '[{"category_id":"Groceries123","amount_value__from":1005000,"amount_scale__from":6,' +
        '"amount_value__to":400,"amount_scale__to":0}]',
    )
  })

  it("reads parts back with the transaction's currencies, keeping their scales", () => {
    const parts = [
      {
        category_id: groceries,
        amount__from: moneyAmount(1005000, 6, 'EUR'),
        amount__to: moneyAmount(400, 0, 'AMD'),
      },
      {
        category_id: gifts,
        amount__from: moneyAmount(1005000, 6, 'EUR'),
        amount__to: moneyAmount(4000, 1, 'AMD'),
      },
    ]
    expect(categoryPartsFromColumn(categoryPartsToColumn(parts), 'EUR', 'AMD')).toEqual(parts)
  })

  it('stores no parts as an empty array', () => {
    expect(categoryPartsToColumn([])).toBe('[]')
    expect(categoryPartsFromColumn('[]', 'EUR', 'EUR')).toEqual([])
  })
})

describe('booleanToColumn / booleanFromColumn', () => {
  it('stores booleans as 1 / 0 and reads them back', () => {
    expect(booleanToColumn(true)).toBe(1)
    expect(booleanToColumn(false)).toBe(0)
    expect(booleanFromColumn(1)).toBe(true)
    expect(booleanFromColumn(0)).toBe(false)
  })
})
