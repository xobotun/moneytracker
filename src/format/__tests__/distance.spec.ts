import { describe, it, expect } from 'vitest'
import { formatMetres } from '../distance'

describe('formatMetres', () => {
  it('shows metres below a kilometre, kilometres with at most one decimal from there', () => {
    expect(formatMetres(10, 'en')).toBe('10\u00a0m')
    expect(formatMetres(999, 'en')).toBe('999\u00a0m')
    expect(formatMetres(1000, 'en')).toBe('1\u00a0km')
    expect(formatMetres(9000, 'en')).toBe('9\u00a0km')
    expect(formatMetres(1250, 'en')).toBe('1.3\u00a0km')
    expect(formatMetres(1250, 'de')).toBe('1,3\u00a0km')
  })
})
