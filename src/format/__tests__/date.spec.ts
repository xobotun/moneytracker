import { describe, it, expect } from 'vitest'
import { formatDay } from '../date'

describe('formatDay', () => {
  it('names a calendar day the same in every time zone', () => {
    expect(formatDay('2026-10-24', 'en-GB')).toBe('24 Oct 2026')
    expect(formatDay('2026-01-01', 'en-GB')).toBe('1 Jan 2026')
  })
})
