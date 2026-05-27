import { describe, it, expect, beforeEach } from 'vitest'
import { getDeviceId, loadLastKnownRemoteState, saveLastKnownRemoteState } from '../localState'

describe('localState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('mints a device id once and returns the same id afterwards', () => {
    const first = getDeviceId()
    const second = getDeviceId()
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('returns null when no remote state has been saved', () => {
    expect(loadLastKnownRemoteState()).toBeNull()
  })

  it('round-trips the last known remote state', () => {
    const state = { device: 'dev-1', uploadedAtUtc: '2026-05-22T10:00:00.000Z', hash: 'abc' }
    saveLastKnownRemoteState(state)
    expect(loadLastKnownRemoteState()).toEqual(state)
  })
})
