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

  describe('with a rank', () => {
    const rank = (row: Record<string, unknown>) => (row.provider === 'manual' ? 3 : 2)
    const manual = (updated: string) => ({ ...alive(updated), provider: 'manual' })
    const auto = (updated: string) => ({ ...alive(updated), provider: 'fawazahmed0' })

    it('lets the higher rank win whatever the timestamps', () => {
      const older = '2026-05-01T00:00:00.000Z'
      const newer = '2026-05-09T00:00:00.000Z'
      expect(resolveConflict(manual(older), auto(newer), rank)).toEqual({
        winner: 'local',
        resolution: 'rank-wins',
      })
      expect(resolveConflict(auto(newer), manual(older), rank)).toEqual({
        winner: 'remote',
        resolution: 'rank-wins',
      })
    })

    it('falls back to the latest update on equal ranks', () => {
      expect(
        resolveConflict(
          manual('2026-05-01T00:00:00.000Z'),
          manual('2026-05-02T00:00:00.000Z'),
          rank,
        ),
      ).toEqual({ winner: 'remote', resolution: 'latest-update-wins' })
    })

    it('still lets a delete win over a higher rank', () => {
      const gone = { ...deleted('2026-05-01T00:00:00.000Z'), provider: 'fawazahmed0' }
      expect(resolveConflict(manual('2026-05-09T00:00:00.000Z'), gone, rank)).toEqual({
        winner: 'remote',
        resolution: 'delete-wins',
      })
    })
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
