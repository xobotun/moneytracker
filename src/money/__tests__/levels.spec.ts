import { describe, it, expect } from 'vitest'
import { MANUAL_PROVIDER, PROVIDER_LEVELS, rankOf } from '../levels'
import { PROVIDERS } from '../providers'

const row = (provider: string | null, via: string | null = null, rate: number | null = 1) => ({
  provider,
  rate,
  via,
})

describe('rankOf', () => {
  it('orders manual, then by level, then direct before cross, then unknown, then none', () => {
    const ranked = [
      row(MANUAL_PROVIDER),
      row('ecb'),
      row('ecb+nbk', 'EUR'),
      row('fawazahmed0'),
      row('fawazahmed0', 'EUR'),
      row('nobody'),
      row(null, null, null),
    ].map((r) => rankOf(r))
    expect([...ranked].sort((a, b) => b - a)).toEqual(ranked)
    expect(new Set(ranked).size).toBe(ranked.length)
  })

  it('ranks a cross over two providers by the first one’s level', () => {
    expect(rankOf(row('nbk+fawazahmed0', 'EUR'))).toBe(rankOf(row('nbk', 'EUR')))
  })

  it('takes the levels from the function it is given', () => {
    const level = (p: string) => (p === 'a' ? 5 : 50)
    expect(rankOf(row('a'), level)).toBeGreaterThan(rankOf(row('b'), level))
  })
})

describe('PROVIDER_LEVELS', () => {
  it('is where every provider the app asks takes its priority from', () => {
    for (const p of PROVIDERS) expect(p.priority, p.id).toBe(PROVIDER_LEVELS[p.id])
  })
})
