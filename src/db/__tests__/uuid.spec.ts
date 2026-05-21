import { describe, it, expect } from 'vitest'
import { newId } from '../uuid'

describe('newId', () => {
  it('returns a 36-character UUID string', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces lexicographically sortable ids over time', async () => {
    const a = newId()
    await new Promise((r) => setTimeout(r, 5))
    const b = newId()
    expect(a < b).toBe(true)
  })

  it('returns unique ids on rapid calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()))
    expect(ids.size).toBe(1000)
  })
})
