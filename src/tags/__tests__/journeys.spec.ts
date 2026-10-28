import { describe, it, expect } from 'vitest'
import { asShortId, type ShortId } from '@/db/shortId'
import { effectiveCurrency, inheritedCurrency } from '../journeys'
import { byId, tag } from './fixtures'

const journey = (id: string, parent: string | null = null) =>
  tag(id, { kind: 'journey', parent_id: parent === null ? null : asShortId(parent) })
const currencies = (entries: Record<string, string>) =>
  new Map<ShortId, { currency: string | null }>(
    Object.entries(entries).map(([id, currency]) => [asShortId(id), { currency }]),
  )

describe('effectiveCurrency and inheritedCurrency', () => {
  // Caucasus (GEL) > Armenia (AMD) > Yerevan; Caucasus > Tbilisi; Summer (none).
  const caucasus = journey('caucasus')
  const armenia = journey('armenia', 'caucasus')
  const yerevan = journey('yerevan', 'armenia')
  const tbilisi = journey('tbilisi', 'caucasus')
  const summer = journey('summer')
  const all = byId(caucasus, armenia, yerevan, tbilisi, summer)
  const details = currencies({ caucasus: 'GEL', armenia: 'AMD' })

  it("is a journey's own currency, else the nearest one above it", () => {
    expect(effectiveCurrency(caucasus, all, details)).toEqual({ currency: 'GEL', from: caucasus })
    expect(effectiveCurrency(armenia, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(effectiveCurrency(yerevan, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(effectiveCurrency(tbilisi, all, details)).toEqual({ currency: 'GEL', from: caucasus })
    expect(effectiveCurrency(summer, all, details)).toEqual({ currency: null, from: null })
  })

  it('is what a journey that sets none inherits under a parent', () => {
    expect(inheritedCurrency(armenia.id, all, details)).toEqual({ currency: 'AMD', from: armenia })
    expect(inheritedCurrency(tbilisi.id, all, details)).toEqual({
      currency: 'GEL',
      from: caucasus,
    })
    expect(inheritedCurrency(null, all, details)).toEqual({ currency: null, from: null })
    expect(inheritedCurrency(summer.id, all, details)).toEqual({ currency: null, from: null })
  })

  it('survives a parent loop that sync left', () => {
    const x = journey('x', 'y')
    const y = journey('y', 'x')
    expect(effectiveCurrency(x, byId(x, y), currencies({}))).toEqual({
      currency: null,
      from: null,
    })
  })
})
