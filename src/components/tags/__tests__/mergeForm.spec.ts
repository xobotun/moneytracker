import { describe, it, expect } from 'vitest'
import { asShortId } from '@/db/shortId'
import { answerError, emptyAnswer, typedValue } from '../mergeForm'

describe('typedValue', () => {
  it('reads the value typed for each kind of detail; empty is none', () => {
    const a = {
      ...emptyAnswer(),
      text: ' Weg 3 ',
      latitude: 52.5,
      longitude: 13.4,
      link: asShortId('rewe00000001'),
      date: new Date(2026, 4, 1),
    }
    expect(typedValue('address', a)).toBe('Weg 3')
    expect(typedValue('position', a)).toEqual({ latitude: 52.5, longitude: 13.4 })
    expect(typedValue('merchant_id', a)).toBe('rewe00000001')
    expect(typedValue('start_date', a)).toBe('2026-05-01')
    expect(typedValue('address', emptyAnswer())).toBeNull()
    expect(typedValue('position', emptyAnswer())).toBeNull()
  })
})

describe('answerError', () => {
  it('needs a choice', () => {
    expect(answerError('address', emptyAnswer())).toBe('Choose one.')
    expect(answerError('address', { ...emptyAnswer(), choice: 'source' })).toBeUndefined()
  })

  it('refuses another radius that is no whole number of metres', () => {
    const other = { ...emptyAnswer(), choice: 'other' as const }
    expect(answerError('radius_metres', { ...other, radius: 0.5 })).toBe(
      'The radius is a whole number of metres, at least 1.',
    )
    expect(answerError('radius_metres', { ...other, radius: 25 })).toBeUndefined()
    expect(typedValue('radius_metres', { ...other, radius: 25 })).toBe(25)
  })

  it('refuses a lone or out-of-range coordinate for another position', () => {
    const other = { ...emptyAnswer(), choice: 'other' as const }
    expect(answerError('position', other)).toBeUndefined() // none: clears it
    expect(answerError('position', { ...other, latitude: 52.5 })).toBe(
      'Enter both coordinates or neither.',
    )
    expect(answerError('position', { ...other, latitude: 200, longitude: 0 })).toBe(
      'Latitude goes from −90 to 90, longitude from −180 to 180.',
    )
    expect(answerError('position', { ...other, latitude: 52.5, longitude: 13.4 })).toBeUndefined()
  })
})
