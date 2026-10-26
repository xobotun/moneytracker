import type { SqlExecutor } from '../db/Database'
import type { SyncConflict, SyncRow } from './types'
import { asShortId, type ShortId } from '../db/shortId'
import { instantFromColumn, instantToColumn } from '../db/columnMappers'
import { redirectTagReferencesByMap } from '../db/tagReferences'
import { readRows, rowsEqual, upsertRow } from './rows'

// The row-by-row merge takes each tag row whole from one side, so it can
// combine changes into states no device produced (decisions §2.5): references
// to a tag merged on the other device, a live tag under a deleted or merged
// parent, parent loops, merge cycles. `repairTags` mends them after the table
// merges, inside the merge's transaction.

/** One side's `tags` rows before a merge, by id. */
export type TagSnapshot = ReadonlyMap<string, SyncRow>

/** What the repair tracks of a tag while it changes them. */
interface TagNode {
  id: string
  parentId: string | null
  mergedIntoId: string | null
  live: boolean
  updatedAt: string
}

type Nodes = ReadonlyMap<string, TagNode>

/**
 * Repairs the merged `tags` (in `tx`), given what each side had before the
 * merge, in three steps:
 *
 *  1. **Merge cycles and redirect.** A cycle of merges (X into Y on one
 *     device, Y into X on another) is broken by undoing the later merge: the
 *     tag in it with the latest `updated_at_utc` is restored — as the side
 *     where it was live had it (with the names the surviving merge gave it),
 *     stamped one millisecond after that latest change, so every device that
 *     meets the cycle writes the same row. Then every reference to a merged
 *     tag moves to the end of its merge chain.
 *  2. **Lift.** A live tag whose parent is deleted or merged moves to the
 *     parent's nearest live ancestor, or to the top level.
 *  3. **Parent loops.** In each loop, the tag with the latest
 *     `updated_at_utc` goes back to its parent on the other side of the merge
 *     (the side its row did not come from) — or to the top level when that
 *     side lacked the row, when that parent would keep the loop, or the second
 *     time the tag has to move.
 *
 * Ties on `updated_at_utc` go to the greatest id. Redirect and lift keep
 * timestamps: every device computes the same result from the same rows.
 * Undoing a merge or a move bumps `updated_at_utc` (a move: to now) so it
 * wins later merges, and is returned as a `loop-undone` conflict whose winner
 * is the side the tag went back to.
 *
 * Loops among deleted tags only are left: nothing shows them, a restored tag
 * whose parent is not live returns at the top level, and a bump would not
 * win a merge for them (a deleted row's merge time is its delete time).
 */
export async function repairTags(
  tx: SqlExecutor,
  before: { local: TagSnapshot; remote: TagSnapshot },
): Promise<SyncConflict[]> {
  const merged = new Map((await readRows(tx, 'tags')).map((row) => [row.id as string, row]))
  const nodes = new Map<string, TagNode>()
  for (const [id, row] of merged) {
    nodes.set(id, {
      id,
      parentId: row.parent_id as string | null,
      mergedIntoId: row.merged_into_id as string | null,
      live: row.deleted_at_utc === null,
      updatedAt: row.updated_at_utc as string,
    })
  }
  const ids = [...nodes.keys()].sort()
  const now = instantToColumn(new Date())

  const conflicts: SyncConflict[] = []
  /** The side the tag's merged row did not come from. */
  const otherSide = (id: string): 'local' | 'remote' => {
    const local = before.local.get(id)
    return local !== undefined && rowsEqual(merged.get(id)!, local) ? 'remote' : 'local'
  }
  const reportUndo = (id: string, winner: 'local' | 'remote') => {
    if (conflicts.some((c) => c.primaryKey === id)) return
    conflicts.push({
      table: 'tags',
      primaryKey: id,
      local: before.local.get(id) ?? {},
      remote: before.remote.get(id) ?? {},
      winner,
      resolution: 'loop-undone',
    })
  }

  // 1. Merge cycles, then the redirect.
  for (const cycle of findCycles(ids, (id) => nodes.get(id)?.mergedIntoId ?? null)) {
    const node = nodes.get(latest(cycle, nodes))!
    const liveSide = (['local', 'remote'] as const).find(
      (side) => before[side].get(node.id)?.deleted_at_utc === null,
    )
    const restored: SyncRow = {
      ...(liveSide ? before[liveSide].get(node.id)! : merged.get(node.id)!),
      merged_into_id: null,
      deleted_at_utc: null,
      updated_at_utc: oneMillisecondAfter(node.updatedAt),
    }
    await upsertRow(tx, 'tags', 'id', restored)
    node.parentId = restored.parent_id as string | null
    node.mergedIntoId = null
    node.live = true
    node.updatedAt = restored.updated_at_utc as string
    reportUndo(node.id, liveSide ?? otherSide(node.id))
  }
  const redirects = chainEnds(nodes)
  if (redirects.size > 0) {
    await redirectTagReferencesByMap(tx, redirects, { bump: false })
    // The redirect moved the children of merged tags.
    const parents = await tx.exec<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM tags',
    )
    for (const row of parents) nodes.get(row.id)!.parentId = row.parent_id
  }

  // 2. Lift. Each walk passes deleted tags only and stops at the first live
  // one, so lifting one tag never changes another's result.
  const lifted: Record<string, string | null> = {}
  for (const id of ids) {
    const node = nodes.get(id)!
    if (!node.live || node.parentId === null || nodes.get(node.parentId)?.live) continue
    node.parentId = nearestLive(nodes, node.parentId, id)
    lifted[id] = node.parentId
  }
  if (Object.keys(lifted).length > 0) {
    await tx.run(
      `UPDATE tags SET parent_id = lift.value
       FROM json_each(?) AS lift
       WHERE tags.id = lift.key`,
      [JSON.stringify(lifted)],
    )
  }

  // 3. Parent loops. After the lift a live tag's parent is live, so a loop
  // reached from a live tag holds live tags only.
  const parentOf = (id: string) => {
    const node = nodes.get(id)
    return node?.live ? node.parentId : null
  }
  const moved = new Set<string>()
  for (let cycles = findCycles(ids, parentOf); cycles.length > 0; ) {
    for (const cycle of cycles) {
      const node = nodes.get(latest(cycle, nodes))!
      let parent: string | null = null
      if (!moved.has(node.id)) {
        moved.add(node.id)
        const side = otherSide(node.id)
        const wanted = (before[side].get(node.id)?.parent_id ?? null) as string | null
        if (wanted !== null) {
          const end = redirects.get(asShortId(wanted)) ?? wanted
          parent = nearestLive(nodes, end, node.id)
        }
        if (parent === node.parentId) parent = null
      }
      node.parentId = parent
      node.updatedAt = later(node.updatedAt, now)
      await tx.run('UPDATE tags SET parent_id = ?, updated_at_utc = ? WHERE id = ?', [
        parent,
        node.updatedAt,
        node.id,
      ])
      reportUndo(node.id, otherSide(node.id))
    }
    cycles = findCycles(ids, parentOf)
  }

  return conflicts
}

/**
 * The cycles of the graph where each id points to at most one `next` (null:
 * nowhere), each listed once, walked from `ids` in order.
 */
function findCycles(ids: readonly string[], next: (id: string) => string | null): string[][] {
  const walked = new Map<string, 'on-path' | 'done'>()
  const cycles: string[][] = []
  for (const start of ids) {
    const path: string[] = []
    let id: string | null = start
    while (id !== null && !walked.has(id)) {
      walked.set(id, 'on-path')
      path.push(id)
      id = next(id)
    }
    if (id !== null && walked.get(id) === 'on-path') cycles.push(path.slice(path.indexOf(id)))
    for (const done of path) walked.set(done, 'done')
  }
  return cycles
}

/** The tag of `ids` with the latest `updated_at_utc`; on a tie, the greatest id. */
function latest(ids: readonly string[], nodes: Nodes): string {
  return ids.reduce((best, id) => {
    const a = nodes.get(best)!.updatedAt
    const b = nodes.get(id)!.updatedAt
    return b > a || (b === a && id > best) ? id : best
  })
}

/** Every merged tag, to the end of its merge chain (the cycles are broken by now). */
function chainEnds(nodes: Nodes): Map<ShortId, ShortId> {
  const ends = new Map<ShortId, ShortId>()
  for (const node of nodes.values()) {
    if (node.mergedIntoId === null) continue
    const path: ShortId[] = []
    let end = asShortId(node.id)
    for (;;) {
      const known = ends.get(end)
      if (known !== undefined) {
        end = known
        break
      }
      const next = nodes.get(end)?.mergedIntoId ?? null
      if (next === null) break
      path.push(end)
      end = asShortId(next)
    }
    for (const id of path) ends.set(id, end)
  }
  return ends
}

/**
 * `start` if it is live, else its nearest live ancestor; null when there is
 * none, or when the walk comes back to `self` or goes round a loop.
 */
function nearestLive(nodes: Nodes, start: string, self: string): string | null {
  const seen = new Set<string>()
  for (let id: string | null = start; id !== null && id !== self && !seen.has(id); ) {
    seen.add(id)
    const node = nodes.get(id)
    if (!node) return null
    if (node.live) return id
    id = node.parentId
  }
  return null
}

/** `now`, or a millisecond after `previous` when the clock is behind it: a bump always moves forward. */
function later(previous: string, now: string): string {
  return now > previous ? now : oneMillisecondAfter(previous)
}

function oneMillisecondAfter(instant: string): string {
  return instantToColumn(new Date(instantFromColumn(instant).getTime() + 1))
}
