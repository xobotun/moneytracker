import { describe, it, expect } from 'vitest'
import { mergeChainEnd } from '../mergeChain'

describe('mergeChainEnd', () => {
  const chain = (links: Record<string, string | null>) => (id: string) => links[id] ?? null

  it('is the tag itself when it is not merged', () => {
    expect(mergeChainEnd('a', chain({}))).toBe('a')
  })

  it('follows the merges to the first unmerged tag', () => {
    expect(mergeChainEnd('x', chain({ x: 'y', y: 'z', z: null }))).toBe('z')
  })

  it('is null when the chain goes round a cycle', () => {
    expect(mergeChainEnd('x', chain({ x: 'y', y: 'z', z: 'y' }))).toBeNull()
    expect(mergeChainEnd('x', chain({ x: 'x' }))).toBeNull()
  })
})
