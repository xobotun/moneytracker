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
  iconToColumn,
  iconFromColumn,
  iconToNullableColumn,
  iconFromNullableColumn,
} from '../columnMappers'
import { asShortId } from '../shortId'
import { asUuid } from '../uuid'
import { emojiIcon, imageIcon, setIcon } from '../../icons/types'

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

describe('iconToColumn / iconFromColumn', () => {
  const IMAGE = asUuid('9a5834b6-061b-5ec2-a5d0-9d6ae48cb098')

  it('writes each kind as a JSON object with its keys in a fixed order', () => {
    expect(iconToColumn(setIcon('pi', 'shop'))).toBe('{"kind":"set","set":"pi","name":"shop"}')
    expect(iconToColumn(emojiIcon('🛒'))).toBe('{"kind":"emoji","emoji":"🛒"}')
    expect(iconToColumn(imageIcon(IMAGE))).toBe(`{"kind":"image","image":"${IMAGE}"}`)
  })

  it('reads each kind back', () => {
    for (const icon of [setIcon('pi', 'shop'), emojiIcon('🛒'), imageIcon(IMAGE)]) {
      expect(iconFromColumn(iconToColumn(icon))).toEqual(icon)
    }
    // Key order does not matter on read.
    expect(iconFromColumn('{"name":"shop","set":"pi","kind":"set"}')).toEqual(setIcon('pi', 'shop'))
  })

  it('keeps an icon of a pack this build does not know as it is', () => {
    const text = '{"kind":"set","set":"material","name":"storefront"}'
    expect(iconFromColumn(text)).toEqual(setIcon('material', 'storefront'))
    expect(iconToColumn(iconFromColumn(text))).toBe(text)
  })

  it('keeps an icon of a kind or shape this build does not know verbatim', () => {
    for (const text of [
      '{"kind":"sticker","pack":"cats","id":7}', // a kind from a newer app
      '{"kind":"emoji","emoji":"🛒","skin":2}', // a field more
      '{"kind":"set","set":"pi"}', // a field less
      '{"kind":"image","image":42}', // a field of another type
      '{"kind":"emoji","emoji":""}', // an empty field
      '"wallet"', // not an object
      '{ "kind" : "set", "set" : "pi" , "name" : "x" , "v" : 2 }', // spacing kept too
    ]) {
      const icon = iconFromColumn(text)
      expect(icon).toEqual({ kind: 'unknown', json: text })
      expect(iconToColumn(icon)).toBe(text)
    }
  })

  it('maps NULL (inherited) both ways', () => {
    expect(iconToNullableColumn(null)).toBeNull()
    expect(iconFromNullableColumn(null)).toBeNull()
    expect(iconFromNullableColumn('{"kind":"emoji","emoji":"🛒"}')).toEqual(emojiIcon('🛒'))
    expect(iconToNullableColumn(emojiIcon('🛒'))).toBe('{"kind":"emoji","emoji":"🛒"}')
  })
})
