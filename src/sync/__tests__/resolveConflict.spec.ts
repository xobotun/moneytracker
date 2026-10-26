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

  describe('on an exact timestamp tie', () => {
    const at = '2026-05-01T00:00:00.000Z'

    it('keeps the row whose content sorts greater, on whichever device decides', () => {
      // Two devices hold different copies with one timestamp (a sync repair
      // that kept it). Each device sees its own copy as local: both must pick
      // the same copy, or they keep their own forever.
      const underD = { ...alive(at), id: 'c', parent_id: 'd' }
      const underG = { ...alive(at), id: 'c', parent_id: 'g' }
      expect(resolveConflict(underD, underG)).toEqual({
        winner: 'remote',
        resolution: 'latest-update-wins',
      })
      expect(resolveConflict(underG, underD)).toEqual({
        winner: 'local',
        resolution: 'latest-update-wins',
      })
    })

    it('compares columns in name order and BLOBs by their bytes', () => {
      const row = (a: number, blob: number[]) => ({ ...alive(at), a, z: new Uint8Array(blob) })
      // The first differing column in name order decides, whatever the key order.
      expect(resolveConflict({ z: 'b', ...alive(at), a: 1 }, row(2, [0])).winner).toBe('remote')
      expect(resolveConflict(row(1, [2]), row(1, [1, 9])).winner).toBe('local')
    })

    it('leaves out the columns the merge ignores', () => {
      // A device-computed cache may differ between the copies: it must not decide.
      const local = { ...alive(at), balance_value: 900, name: 'A' }
      const remote = { ...alive(at), balance_value: 100, name: 'B' }
      expect(resolveConflict(local, remote, undefined, ['balance_value']).winner).toBe('remote')
      expect(resolveConflict(remote, local, undefined, ['balance_value']).winner).toBe('local')
    })

    it('keeps local when the rows are the same', () => {
      expect(resolveConflict(alive(at), alive(at))).toEqual({
        winner: 'local',
        resolution: 'latest-update-wins',
      })
    })
  })
})
