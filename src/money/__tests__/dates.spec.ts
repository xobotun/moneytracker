import { describe, it, expect } from 'vitest'
import { addDays, todayLocal } from '../dates'

describe('addDays', () => {
  it('steps over month and year ends', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01')
    expect(addDays('2026-10-25', -7)).toBe('2026-10-18')
  })
})

describe('todayLocal', () => {
  it("is the device's calendar date, not the UTC one", () => {
    // Local constructor: late evening on 25 Oct wherever the tests run.
    expect(todayLocal(new Date(2026, 9, 25, 23, 30))).toBe('2026-10-25')
    expect(todayLocal(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })
})
