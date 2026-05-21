import { describe, it, expect } from 'vitest'
import { localMoment } from '../LocalMoment'

describe('LocalMoment', () => {
  it('constructs a frozen { local, zone } pair', () => {
    const m = localMoment('2013-10-07T04:23:19.120+04:00', 'Europe/Berlin')
    expect(m.local).toBe('2013-10-07T04:23:19.120+04:00')
    expect(m.zone).toBe('Europe/Berlin')
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('rejects empty local string', () => {
    expect(() => localMoment('', 'UTC')).toThrow()
  })

  it('rejects empty zone', () => {
    expect(() => localMoment('2013-10-07T04:23:19.120Z', '')).toThrow()
  })
})
