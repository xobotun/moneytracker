import type { Database, SqlExecutor } from '../Database'
import type { Tag, TagDetailConflict, TagDetailField, TagDetailValues, TagKind } from '../types'
import { asShortId, newShortId, type ShortId } from '../shortId'
import { mergeChainEnd } from '../mergeChain'
import {
  CategoryInUseError,
  DuplicateTagNameError,
  MergeConflictError,
  TagKindMismatchError,
  TagLoopError,
} from '../errors'
import {
  DETAIL_FIELDS_BY_KIND,
  assertDetailLinks,
  readDetailValues,
  writeDetailValues,
} from './TagDetailsRepository'
import { countTagUsage, redirectTagReferences } from '../tagReferences'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
  optionalTextToColumn,
  shortIdFromColumn,
  shortIdFromNullableColumn,
} from '../columnMappers'

export type TagRow = {
  id: string
  kind: string
  name: string
  parent_id: string | null
  moved_at_utc: string
  description: string | null
  synonyms: string
  colour: string | null
  icon: string | null
  merged_into_id: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export type TagCreateInput = {
  kind: TagKind
  name: string
  parent_id?: ShortId | null
  description?: string | null
  synonyms?: string[]
  colour?: string | null
  icon?: string | null
}

export type TagUpdateInput = {
  name?: string
  description?: string | null
  synonyms?: string[]
  colour?: string | null
  icon?: string | null
}

export function rowToTag(row: TagRow): Tag {
  return {
    id: shortIdFromColumn(row.id),
    kind: row.kind as TagKind, // the CHECK constraint allows only TagKind values
    name: row.name,
    parent_id: shortIdFromNullableColumn(row.parent_id),
    moved_at_utc: instantFromColumn(row.moved_at_utc),
    description: row.description,
    synonyms: jsonArrayFromColumn<string>(row.synonyms),
    colour: row.colour,
    icon: row.icon,
    merged_into_id: shortIdFromNullableColumn(row.merged_into_id),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

/** Names are compared ignoring case, in a way that also works beyond ASCII (SQLite's lower() does not). */
function foldCase(name: string): string {
  return name.toLocaleLowerCase()
}

/** Everything a tag is found by: its name and its synonyms. */
function namesOf(tag: Pick<Tag, 'name' | 'synonyms'>): string[] {
  return [tag.name, ...tag.synonyms]
}

/** The tags called `key` (case-folded): main names first, then synonyms, each in the given order. */
function byName(tags: readonly Tag[], key: string): Tag[] {
  const named = tags.filter((t) => foldCase(t.name) === key)
  return [
    ...named,
    ...tags.filter((t) => !named.includes(t) && t.synonyms.some((s) => foldCase(s) === key)),
  ]
}

async function selectTag(ex: SqlExecutor, id: ShortId, liveOnly: boolean): Promise<Tag | null> {
  const rows = await ex.exec<TagRow>(
    `SELECT * FROM tags WHERE id = ?${liveOnly ? ' AND deleted_at_utc IS NULL' : ''}`,
    [id],
  )
  return rows.length === 0 ? null : rowToTag(rows[0]!)
}

async function liveTagOrThrow(ex: SqlExecutor, id: ShortId, role: string): Promise<Tag> {
  const tag = await selectTag(ex, id, true)
  if (!tag) throw new Error(`${role} ${id} not found`)
  return tag
}

/** Both tags must be live and of one kind; the pair's kind is returned. */
async function mergePair(
  ex: SqlExecutor,
  sourceId: ShortId,
  targetId: ShortId,
): Promise<{ source: Tag; target: Tag }> {
  const source = await liveTagOrThrow(ex, sourceId, 'Tag')
  const target = await liveTagOrThrow(ex, targetId, 'Target tag')
  if (source.kind !== target.kind) {
    throw new TagKindMismatchError(
      `"${source.name}", a ${source.kind}, cannot be merged into "${target.name}", a ${target.kind}`,
    )
  }
  return { source, target }
}

function sameDetail(a: TagDetailValues[TagDetailField], b: TagDetailValues[TagDetailField]) {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return a.latitude === b.latitude && a.longitude === b.longitude
  }
  return a === b
}

/** The fields of the kind where source and target both have a value and the values differ. */
async function detailConflictsIn(
  ex: SqlExecutor,
  source: Tag,
  target: Tag,
): Promise<TagDetailConflict[]> {
  const s = await readDetailValues(ex, source.id, source.kind)
  const t = await readDetailValues(ex, target.id, target.kind)
  const conflicts: TagDetailConflict[] = []
  for (const field of DETAIL_FIELDS_BY_KIND[source.kind]) {
    if (s[field] !== null && t[field] !== null && !sameDetail(s[field], t[field])) {
      conflicts.push({ field, source: s[field], target: t[field] } as TagDetailConflict)
    }
  }
  return conflicts
}

/** The parent must be a live tag of the child's kind. */
async function assertParent(ex: SqlExecutor, kind: TagKind, parentId: ShortId): Promise<void> {
  const parent = await liveTagOrThrow(ex, parentId, 'Parent tag')
  if (parent.kind !== kind) {
    throw new TagKindMismatchError(`A ${kind} cannot go under "${parent.name}", a ${parent.kind}`)
  }
}

/**
 * Throws if one of `names` is already a name or synonym of a live tag of the
 * same kind and parent (other than `exceptId`), ignoring case. Duplicates that
 * sync brought in are not refused here; only new ones are.
 */
async function assertNamesFree(
  ex: SqlExecutor,
  kind: TagKind,
  parentId: ShortId | null,
  names: readonly string[],
  exceptId?: ShortId,
): Promise<void> {
  if (names.length === 0) return
  const wanted = new Map(names.map((name) => [foldCase(name), name]))
  const siblings = await ex.exec<TagRow>(
    'SELECT * FROM tags WHERE kind = ? AND parent_id IS ? AND deleted_at_utc IS NULL',
    [kind, parentId],
  )
  for (const sibling of siblings.map(rowToTag)) {
    if (sibling.id === exceptId) continue
    for (const taken of namesOf(sibling)) {
      const clash = wanted.get(foldCase(taken))
      if (clash !== undefined) throw new DuplicateTagNameError(clash)
    }
  }
}

/**
 * When `parentId` is `id` itself or one of its descendants, the names from
 * `id` down to `parentId` (e.g. X > A > Y); otherwise null. Walks up from
 * `parentId` over tags of any liveness, and stops on a loop already in the
 * data (sync can leave one until it is repaired).
 */
async function loopPath(ex: SqlExecutor, id: ShortId, parentId: ShortId): Promise<string[] | null> {
  const rows = await ex.exec<{ id: string; name: string; parent_id: string | null }>(
    'SELECT id, name, parent_id FROM tags',
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  const upwards: string[] = []
  const seen = new Set<string>()
  for (let current: string | null = parentId; current !== null && !seen.has(current); ) {
    seen.add(current)
    const row = byId.get(current)
    if (!row) break
    upwards.push(row.name)
    if (current === id) return upwards.reverse()
    current = row.parent_id
  }
  return null
}

/**
 * Tags of all five kinds: categories, merchants, locations, journeys and
 * plain tags. A tag can have a parent of its own kind. Names and synonyms are
 * unique among the live tags of one kind and parent, ignoring case — checked
 * here on create / update / move only, since sync may bring duplicates in
 * (two devices creating the same tag offline); `duplicates()` lists those.
 */
export class TagsRepository {
  constructor(private db: Database) {}

  async create(input: TagCreateInput): Promise<Tag> {
    const id = newShortId()
    const now = instantToColumn(new Date())
    const parentId = input.parent_id ?? null
    const synonyms = input.synonyms ?? []
    await this.db.transaction(async (tx) => {
      if (parentId !== null) await assertParent(tx, input.kind, parentId)
      await assertNamesFree(tx, input.kind, parentId, [input.name, ...synonyms])
      await tx.run(
        `INSERT INTO tags (id, kind, name, parent_id, moved_at_utc, description, synonyms, colour,
                           icon, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.kind,
          input.name,
          parentId,
          now,
          optionalTextToColumn(input.description),
          jsonArrayToColumn(synonyms),
          optionalTextToColumn(input.colour),
          optionalTextToColumn(input.icon),
          now,
          now,
        ],
      )
    })
    return (await this.findById(id))!
  }

  /** The live tag with this id, or null. */
  async findById(id: ShortId): Promise<Tag | null> {
    return selectTag(this.db, id, true)
  }

  /** Every tag, deleted and merged ones included (to show names of references and redirect merged ones). */
  async listAll(): Promise<Tag[]> {
    const rows = await this.db.exec<TagRow>('SELECT * FROM tags ORDER BY name, id')
    return rows.map(rowToTag)
  }

  /** Live tags, of one kind or all, ordered by name. */
  async list(kind?: TagKind): Promise<Tag[]> {
    const rows =
      kind === undefined
        ? await this.db.exec<TagRow>(
            'SELECT * FROM tags WHERE deleted_at_utc IS NULL ORDER BY name, id',
          )
        : await this.db.exec<TagRow>(
            'SELECT * FROM tags WHERE kind = ? AND deleted_at_utc IS NULL ORDER BY name, id',
            [kind],
          )
    return rows.map(rowToTag)
  }

  /**
   * The live tag of `kind` called `name`, by its name or a synonym, ignoring
   * case. `parentId`: null = top level only; undefined = under any parent.
   * Among several matches (sync duplicates, or other parents) a main name
   * beats a synonym, then the oldest tag wins.
   *
   * When no live tag matches, the merged tags of `kind` (under `parentId`)
   * are matched the same way, and the answer is the live tag at the end of
   * the first match's merge chain whose end is live. A merge gives the
   * target the source's names, but sync does not carry them along a chain
   * merged on two devices (X into Y here, Y into Z there: Z lacks X's names).
   */
  async findByName(kind: TagKind, name: string, parentId?: ShortId | null): Promise<Tag | null> {
    const key = foldCase(name)
    const live = byName(await this.selectNamed(kind, 'deleted_at_utc IS NULL', parentId), key)
    if (live.length > 0) return live[0]!
    const merged = byName(await this.selectNamed(kind, 'merged_into_id IS NOT NULL', parentId), key)
    if (merged.length === 0) return null
    const links = await this.db.exec<{ id: string; merged_into_id: string | null; live: number }>(
      'SELECT id, merged_into_id, deleted_at_utc IS NULL AS live FROM tags WHERE kind = ?',
      [kind],
    )
    const byId = new Map(links.map((link) => [link.id, link]))
    for (const tag of merged) {
      const end = mergeChainEnd(tag.id, (id) => byId.get(id)?.merged_into_id ?? null)
      if (end !== null && byId.get(end)?.live === 1) return selectTag(this.db, asShortId(end), true)
    }
    return null
  }

  /** Tags of `kind` matching `filter` (SQL), under `parentId` when given, oldest first. */
  private async selectNamed(
    kind: TagKind,
    filter: string,
    parentId: ShortId | null | undefined,
  ): Promise<Tag[]> {
    const params: unknown[] = [kind]
    let where = `kind = ? AND ${filter}`
    if (parentId !== undefined) {
      where += ' AND parent_id IS ?'
      params.push(parentId)
    }
    const rows = await this.db.exec<TagRow>(
      `SELECT * FROM tags WHERE ${where} ORDER BY created_at_utc, id`,
      params,
    )
    return rows.map(rowToTag)
  }

  /**
   * Changes the given fields. A new name or synonym must not be taken at the
   * tag's level; names the tag already had are not checked again.
   */
  async update(id: ShortId, patch: TagUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      params.push(optionalTextToColumn(patch.description))
    }
    if (patch.synonyms !== undefined) {
      sets.push('synonyms = ?')
      params.push(jsonArrayToColumn(patch.synonyms))
    }
    if (patch.colour !== undefined) {
      sets.push('colour = ?')
      params.push(optionalTextToColumn(patch.colour))
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?')
      params.push(optionalTextToColumn(patch.icon))
    }
    if (sets.length === 0) return
    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.transaction(async (tx) => {
      if (patch.name !== undefined || patch.synonyms !== undefined) {
        const tag = await liveTagOrThrow(tx, id, 'Tag')
        const had = new Set(namesOf(tag).map(foldCase))
        const next = namesOf({
          name: patch.name ?? tag.name,
          synonyms: patch.synonyms ?? tag.synonyms,
        })
        const added = next.filter((name) => !had.has(foldCase(name)))
        await assertNamesFree(tx, tag.kind, tag.parent_id, added, id)
      }
      await tx.run(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, params)
    })
  }

  /** Puts the tag under `parentId` (a live tag of its kind, not its own descendant), or at the top level. */
  async move(id: ShortId, parentId: ShortId | null): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const tag = await liveTagOrThrow(tx, id, 'Tag')
      if (tag.parent_id === parentId) return
      if (parentId !== null) {
        await assertParent(tx, tag.kind, parentId)
        const path = await loopPath(tx, id, parentId)
        if (path) throw new TagLoopError(path)
      }
      await assertNamesFree(tx, tag.kind, parentId, namesOf(tag), id)
      await tx.run(
        'UPDATE tags SET parent_id = ?, moved_at_utc = ?, updated_at_utc = ? WHERE id = ?',
        [parentId, now, now, id],
      )
    })
  }

  /**
   * The detail fields (address, position, merchant, default category, journey
   * dates) where the source and the target both have a value and the values
   * differ: a merge needs a decision for each of them.
   */
  async detailConflicts(sourceId: ShortId, targetId: ShortId): Promise<TagDetailConflict[]> {
    const { source, target } = await mergePair(this.db, sourceId, targetId)
    return detailConflictsIn(this.db, source, target)
  }

  /**
   * Merges the source tag into the target, a live tag of the same kind that is
   * not the source or one of its descendants (decisions §2.5): every
   * reference to the source moves to the target (two category parts of one
   * transaction are summed), the source's children move under it, and the
   * source's name and synonyms become the target's synonyms. The target keeps
   * its colour, icon and description. The source is soft-deleted and
   * remembers the target, so sync redirects what other devices still point at
   * it. Name clashes among the moved children are kept (shown as duplicates).
   *
   * The source's details fill the target's empty ones. Where both have
   * different values, `resolved` must give the value (one of the two, or a
   * third; null clears it) or a MergeConflictError lists the fields and
   * nothing is changed. Fields of other kinds in `resolved` are ignored.
   */
  async merge(
    sourceId: ShortId,
    targetId: ShortId,
    resolved: Partial<TagDetailValues> = {},
  ): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const { source, target } = await mergePair(tx, sourceId, targetId)
      const path = await loopPath(tx, sourceId, targetId)
      if (path) throw new TagLoopError(path)

      const fields = DETAIL_FIELDS_BY_KIND[target.kind]
      if (fields.length > 0) {
        const unresolved = (await detailConflictsIn(tx, source, target)).filter(
          (c) => resolved[c.field] === undefined,
        )
        if (unresolved.length > 0) throw new MergeConflictError(unresolved)
        const from = await readDetailValues(tx, sourceId, source.kind)
        const into = await readDetailValues(tx, targetId, target.kind)
        const next = { ...into }
        for (const field of fields) {
          const value =
            resolved[field] !== undefined ? resolved[field] : (into[field] ?? from[field])
          ;(next as Record<TagDetailField, unknown>)[field] = value ?? null
        }
        await assertDetailLinks(tx, target.kind, next)
        if (fields.some((field) => !sameDetail(next[field], into[field]))) {
          await writeDetailValues(tx, targetId, target.kind, next, now)
        }
      }

      await redirectTagReferences(tx, sourceId, targetId, { bump: true, now })

      const taken = new Set(namesOf(target).map(foldCase))
      const added: string[] = []
      for (const name of namesOf(source)) {
        if (taken.has(foldCase(name))) continue
        taken.add(foldCase(name))
        added.push(name)
      }
      if (added.length > 0) {
        await tx.run('UPDATE tags SET synonyms = ?, updated_at_utc = ? WHERE id = ?', [
          jsonArrayToColumn([...target.synonyms, ...added]),
          now,
          targetId,
        ])
      }
      await tx.run(
        `UPDATE tags SET merged_into_id = ?, deleted_at_utc = ?, updated_at_utc = ?
         WHERE id = ?`,
        [targetId, now, now, sourceId],
      )
    })
  }

  /** How many live transactions and accounts use the tag (each counted once). */
  async usageCount(id: ShortId): Promise<number> {
    return countTagUsage(this.db, id)
  }

  /**
   * Soft-deletes the tag. Its live children move up to its parent (or to the
   * top level) in the same transaction. References to it stay, so restoring
   * the tag brings it back everywhere. A category in use cannot be deleted
   * (every transaction needs one): it is merged into another one instead.
   */
  async softDelete(id: ShortId): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const tag = await selectTag(tx, id, true)
      if (!tag) return
      if (tag.kind === 'category') {
        const uses = await countTagUsage(tx, id)
        if (uses > 0) {
          throw new CategoryInUseError(
            `"${tag.name}" is used by ${uses} transaction${uses === 1 ? '' : 's'}; merge it into another category instead`,
          )
        }
      }
      await tx.run(
        `UPDATE tags SET parent_id = ?, updated_at_utc = ?
         WHERE parent_id = ? AND deleted_at_utc IS NULL`,
        [tag.parent_id, now, id],
      )
      await tx.run('UPDATE tags SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?', [
        now,
        now,
        id,
      ])
    })
  }

  /**
   * Brings a deleted tag back. A tag merged into another one cannot come back
   * (its references now point to the other tag). When its parent is no longer
   * live, the tag returns at the top level.
   */
  async restore(id: ShortId): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const tag = await selectTag(tx, id, false)
      if (!tag) throw new Error(`Tag ${id} not found`)
      if (tag.merged_into_id !== null) {
        throw new Error(`"${tag.name}" was merged into another tag and cannot be restored`)
      }
      if (tag.deleted_at_utc === null) return
      const parentLive =
        tag.parent_id !== null && (await selectTag(tx, tag.parent_id, true)) !== null
      await tx.run(
        'UPDATE tags SET parent_id = ?, deleted_at_utc = NULL, updated_at_utc = ? WHERE id = ?',
        [parentLive ? tag.parent_id : null, now, id],
      )
    })
  }

  /**
   * Groups of live tags that share a kind, a parent and a name or synonym
   * (ignoring case) — what sync leaves when two devices create the same tag
   * offline. Tags linked through a chain of shared names form one group. Ids
   * are sorted within a group, groups by their first id.
   */
  async duplicates(): Promise<ShortId[][]> {
    const rows = await this.db.exec<TagRow>(
      'SELECT * FROM tags WHERE deleted_at_utc IS NULL ORDER BY id',
    )
    const tags = rows.map(rowToTag)

    // Union-find: each tag points towards its group's representative.
    const link = new Map<ShortId, ShortId>(tags.map((t) => [t.id, t.id]))
    const find = (id: ShortId): ShortId => {
      let root = id
      while (link.get(root) !== root) root = link.get(root)!
      return root
    }
    const firstWithKey = new Map<string, ShortId>()
    for (const tag of tags) {
      for (const name of new Set(namesOf(tag).map(foldCase))) {
        const key = JSON.stringify([tag.kind, tag.parent_id, name])
        const first = firstWithKey.get(key)
        if (first === undefined) firstWithKey.set(key, tag.id)
        else link.set(find(tag.id), find(first))
      }
    }

    const groups = new Map<ShortId, ShortId[]>()
    for (const tag of tags) {
      const root = find(tag.id)
      groups.set(root, [...(groups.get(root) ?? []), tag.id])
    }
    return [...groups.values()].filter((group) => group.length > 1)
  }
}
