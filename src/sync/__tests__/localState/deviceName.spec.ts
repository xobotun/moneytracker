import { describe, it, expect, beforeEach } from 'vitest'
import {
  getDeviceName,
  setDeviceName,
  defaultDeviceName,
  parseUserAgent,
} from '../../localState/deviceName'

describe('parseUserAgent', () => {
  it('recognises Chrome on Windows', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    expect(parseUserAgent(ua)).toBe('Chrome on Windows')
  })

  it('recognises Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
    expect(parseUserAgent(ua)).toBe('Firefox on Linux')
  })

  it('recognises Safari on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    expect(parseUserAgent(ua)).toBe('Safari on macOS')
  })

  it('recognises Edge over Chrome (Edg/ token wins)', () => {
    // Edge UA also contains "Chrome/" so the Edg/ check must come first.
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    expect(parseUserAgent(ua)).toBe('Edge on Windows')
  })

  it('recognises Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    expect(parseUserAgent(ua)).toBe('Chrome on Android')
  })

  it('returns a sensible fallback for an unrecognised UA', () => {
    expect(parseUserAgent('something weird')).toBe('Unknown browser on Unknown OS')
  })
})

describe('defaultDeviceName', () => {
  it('produces "<browser> on <os> · <8 hex chars>"', () => {
    expect(defaultDeviceName()).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)
  })

  it('produces a different random suffix on each call', () => {
    const a = defaultDeviceName()
    const b = defaultDeviceName()
    expect(a).not.toBe(b)
  })
})

describe('getDeviceName / setDeviceName', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('mints, persists, and returns a default on first call', () => {
    const first = getDeviceName()
    expect(first).toMatch(/^.+ on .+ · [0-9a-f]{8}$/)
    // Subsequent calls return the same persisted value — random suffix is stable.
    expect(getDeviceName()).toBe(first)
  })

  it('overwrites with setDeviceName and reads the new value back', () => {
    getDeviceName() // mint a default
    setDeviceName('My laptop')
    expect(getDeviceName()).toBe('My laptop')
  })
})
