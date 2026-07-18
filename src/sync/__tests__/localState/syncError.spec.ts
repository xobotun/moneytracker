import { describe, it, expect, beforeEach } from 'vitest'
import { loadSyncError, saveSyncError, clearSyncError } from '../../localState/syncError'

describe('syncError', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when no error has been saved', () => {
    expect(loadSyncError()).toBeNull()
  })

  it('round-trips a saved error', () => {
    const e = { atUtc: '2026-05-28T10:00:00.000Z', message: 'Auth failed' }
    saveSyncError(e)
    expect(loadSyncError()).toEqual(e)
  })

  it('clear() removes the saved error', () => {
    saveSyncError({ atUtc: '2026-05-28T10:00:00.000Z', message: 'X' })
    clearSyncError()
    expect(loadSyncError()).toBeNull()
  })
})
