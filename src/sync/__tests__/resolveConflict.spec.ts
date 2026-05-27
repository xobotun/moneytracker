import { describe, it, expect } from 'vitest'
import { resolveConflict } from '../resolveConflict'

const alive = (updated: string) => ({ updated_at_utc: updated, deleted_at_utc: null })
const deleted = (at: string) => ({ updated_at_utc: at, deleted_at_utc: at })

describe('resolveConflict', () => {
  it('lets a delete win over a concurrent update regardless of timestamps', () => {
    const local = deleted('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-09T00:00:00.000Z') // newer, but only an update
    expect(resolveConflict(local, remote)).toEqual({ winner: 'local', resolution: 'delete-wins' })
  })

  it('lets the remote delete win over a local update', () => {
    const local = alive('2026-05-09T00:00:00.000Z')
    const remote = deleted('2026-05-01T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({ winner: 'remote', resolution: 'delete-wins' })
  })

  it('picks the latest update when neither side is deleted', () => {
    const local = alive('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-02T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'remote',
      resolution: 'latest-update-wins',
    })
  })

  it('picks the latest delete when both sides are deleted', () => {
    const local = deleted('2026-05-05T00:00:00.000Z')
    const remote = deleted('2026-05-03T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'local',
      resolution: 'latest-update-wins',
    })
  })

  it('breaks an exact timestamp tie in favour of local, deterministically', () => {
    const local = alive('2026-05-01T00:00:00.000Z')
    const remote = alive('2026-05-01T00:00:00.000Z')
    expect(resolveConflict(local, remote)).toEqual({
      winner: 'local',
      resolution: 'latest-update-wins',
    })
  })
})
