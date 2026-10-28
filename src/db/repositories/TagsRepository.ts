import type { Database, SqlExecutor } from '../Database'
import type { Tag, TagDetailConflict, TagDetailField, TagDetailValues, TagKind } from '../types'
import type { Icon } from '../../icons/types'
import { asShortId, newShortId, type ShortId } from '../shortId'
import { mergeChainEnd } from '../mergeChain'
import {
  CategoryInUseError,
  DeletedTagError,
  DuplicateTagNameError,
  MergeConflictError,
  TagKindMismatchError,
  TagLoopError,
  TagNotFoundError,
} from '../errors'
import {
  DEFAULT_LOCATION_RADIUS_METRES,
  DETAIL_FIELDS_BY_KIND,
  assertDetailLinks,
  assertJourneyCurrency,
  assertJourneyDates,
  journeyCurrencyToColumn,
  noDetails,
  readDetailValues,
  writeDetailValues,
} from './TagDetailsRepository'
import { countTagUsage, redirectTagReferences } from '../tagReferences'
import {
  applyOtherNames,
  carriedNames,
  foldCase,
  mergedNames,
  namesAddedByMerge,
  retiredAfterMerge,
} from '@/tags/otherNames'
import {
  iconFromNullableColumn,
  iconToNullableColumn,
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
  retired_names: string
  colour: string | null
  icon: string | null
  merged_into_id: string | null
  archived_at_utc: string | null
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
  icon?: Icon | null
  /** The details of a location, merchant or journey, written in the same transaction. */
  details?: TagDetailValues
}

/** Everything the edit dialog saves at once (see `save`). */
export type TagSaveInput = {
  name: string
  parent_id: ShortId | null
  description: string | null
  /** The synonyms and merged names to keep (see `applyOtherNames`). */
  otherNames: string[]
  colour: string | null // null = inherited
  icon: Icon | null // null = inherited
  /** The fields of the tag's kind are saved; the others are ignored. */
  details: TagDetailValues
}

export type TagUpdateInput = {
  name?: string
  description?: string | null
  synonyms?: string[]
  colour?: string | null
  icon?: Icon | null
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
    retired_names: jsonArrayFromColumn<string>(row.retired_names),
    colour: row.colour,
    icon: iconFromNullableColumn(row.icon),
    merged_into_id: shortIdFromNullableColumn(row.merged_into_id),
    archived_at_utc: instantFromNullableColumn(row.archived_at_utc),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
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

/** The live tag `id`; a TagNotFoundError when there is none, a DeletedTagError when it is deleted. */
async function liveTagOrThrow(ex: SqlExecutor, id: ShortId, role: string): Promise<Tag> {
  const tag = await selectTag(ex, id, false)
  if (!tag) throw new TagNotFoundError(`${role} ${id} not found`)
  if (tag.deleted_at_utc !== null) throw new DeletedTagError(`${role} "${tag.name}" is deleted`)
  return tag
}

/** Both tags must be live and of one kind; returns them. */
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

/**
 * The fields of `kind` from `values`, the others empty; empty text is none,
 * and an empty radius or matching flag the default. A currency is stored
 * trimmed and upper-cased.
 */
function detailsOfKind(kind: TagKind, values: TagDetailValues): TagDetailValues {
  const next = noDetails()
  for (const field of DETAIL_FIELDS_BY_KIND[kind]) {
    ;(next as Record<TagDetailField, unknown>)[field] = values[field]
  }
  next.address = optionalTextToColumn(next.address)
  next.start_date = optionalTextToColumn(next.start_date)
  next.end_date = optionalTextToColumn(next.end_date)
  next.currency = journeyCurrencyToColumn(next.currency)
  if (kind === 'location') next.radius_metres ??= DEFAULT_LOCATION_RADIUS_METRES
  if (kind === 'location' || kind === 'merchant') next.auto_match ??= true
  return next
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
 * here on create / update / move only. Duplicates still arise: sync brings
 * them in (two devices creating the same tag offline), deleting or merging a
 * tag moves its children next to siblings that may share a name, and a
 * restore brings back a name that was taken meanwhile. `duplicates()` lists
 * them.
 */
export class TagsRepository {
  constructor(private db: Database) {}

  async create(input: TagCreateInput): Promise<Tag> {
    const id = newShortId()
    const now = instantToColumn(new Date())
    const parentId = input.parent_id ?? null
    const synonyms = input.synonyms ?? []
    const details = input.details ? detailsOfKind(input.kind, input.details) : null
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
          iconToNullableColumn(input.icon ?? null),
          now,
          now,
        ],
      )
      if (details && DETAIL_FIELDS_BY_KIND[input.kind].some((field) => details[field] !== null)) {
        await assertDetailLinks(tx, input.kind, details)
        assertJourneyDates(details)
        assertJourneyCurrency(details.currency)
        await writeDetailValues(tx, id, input.kind, details, now)
      }
    })
    return (await this.findById(id))!
  }

  /**
   * Saves what the edit dialog shows, in one transaction: the tag's fields,
   * its parent and its details, so a refusal changes nothing. Names are
   * checked at the parent the tag ends up under — all of them when it moves,
   * only new ones when it stays. A merged name left out of `otherNames` is
   * retired, so it stops finding the tag (src/tags/otherNames.ts). Only what
   * changed is written: an unchanged save stamps nothing. A link the details
   * already have is not checked again (see `assertDetailLinks`).
   */
  async save(id: ShortId, input: TagSaveInput): Promise<void> {
    const now = instantToColumn(new Date())
    const name = input.name.trim()
    const parentId = input.parent_id
    await this.db.transaction(async (tx) => {
      const tag = await liveTagOrThrow(tx, id, 'Tag')
      const kindRows = await tx.exec<TagRow>('SELECT * FROM tags WHERE kind = ?', [tag.kind])
      const { synonyms, retired_names: retired } = applyOtherNames(
        { name, synonyms: tag.synonyms, retired_names: tag.retired_names },
        carriedNames(id, kindRows.map(rowToTag)),
        input.otherNames,
      )
      const moves = parentId !== tag.parent_id
      if (moves && parentId !== null) {
        await assertParent(tx, tag.kind, parentId)
        const path = await loopPath(tx, id, parentId)
        if (path) throw new TagLoopError(path)
      }
      const had = new Set(moves ? [] : namesOf(tag).map(foldCase))
      const unchecked = [name, ...synonyms].filter((n) => !had.has(foldCase(n)))
      await assertNamesFree(tx, tag.kind, parentId, unchecked, id)

      const sets: string[] = []
      const params: unknown[] = []
      const set = (column: string, value: unknown) => {
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (name !== tag.name) set('name', name)
      const description = optionalTextToColumn(input.description)
      if (description !== tag.description) set('description', description)
      if (JSON.stringify(synonyms) !== JSON.stringify(tag.synonyms)) {
        set('synonyms', jsonArrayToColumn(synonyms))
      }
      if (JSON.stringify(retired) !== JSON.stringify(tag.retired_names)) {
        set('retired_names', jsonArrayToColumn(retired))
      }
      const colour = optionalTextToColumn(input.colour)
      if (colour !== tag.colour) set('colour', colour)
      const icon = iconToNullableColumn(input.icon)
      if (icon !== iconToNullableColumn(tag.icon)) set('icon', icon)
      if (moves) {
        set('parent_id', parentId)
        set('moved_at_utc', now)
      }
      if (sets.length > 0) {
        set('updated_at_utc', now)
        await tx.run(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
      }

      const fields = DETAIL_FIELDS_BY_KIND[tag.kind]
      if (fields.length === 0) return
      const stored = await readDetailValues(tx, id, tag.kind)
      const next = detailsOfKind(tag.kind, input.details)
      const changed = fields.filter((field) => !sameDetail(next[field], stored[field]))
      if (changed.length === 0) return
      await assertDetailLinks(tx, tag.kind, next, stored)
      if (changed.includes('start_date') || changed.includes('end_date')) {
        assertJourneyDates(next)
      }
      if (changed.includes('currency')) assertJourneyCurrency(next.currency)
      await writeDetailValues(tx, id, tag.kind, next, now)
    })
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
   * case. `parentId`: null = at the top level; undefined = under any parent.
   * Among several matches (sync duplicates, or other parents) a main name
   * beats a synonym, then the oldest tag wins.
   *
   * When no live tag matches, the merged tags of `kind` (under `parentId`)
   * are matched the same way, and the answer is the live tag at the end of
   * the first match's merge chain whose end is live — wherever that tag sits,
   * so with `parentId` null it may not be a top-level one. A merge gives the
   * target the source's names, but sync does not carry them along a chain
   * merged on two devices (X into Y here, Y into Z there: Z lacks X's names).
   * A match is skipped when a tag on its chain, the end included, has retired
   * the name (its `retired_names`: the user removed it).
   */
  async findByName(kind: TagKind, name: string, parentId?: ShortId | null): Promise<Tag | null> {
    const key = foldCase(name)
    const live = byName(await this.selectNamed(kind, 'deleted_at_utc IS NULL', parentId), key)
    if (live.length > 0) return live[0]!
    const merged = byName(await this.selectNamed(kind, 'merged_into_id IS NOT NULL', parentId), key)
    if (merged.length === 0) return null
    const links = await this.db.exec<{
      id: string
      merged_into_id: string | null
      retired_names: string
      live: number
    }>(
      `SELECT id, merged_into_id, retired_names, deleted_at_utc IS NULL AS live
       FROM tags WHERE kind = ?`,
      [kind],
    )
    const byId = new Map(links.map((link) => [link.id, link]))
    const retires = (id: string) =>
      jsonArrayFromColumn<string>(byId.get(id)?.retired_names ?? '[]').some(
        (retired) => foldCase(retired) === key,
      )
    for (const tag of merged) {
      // mergeChainEnd asks for every tag on the way, the end included.
      const chain: string[] = []
      const end = mergeChainEnd(tag.id, (id) => {
        chain.push(id)
        return byId.get(id)?.merged_into_id ?? null
      })
      if (end === null || byId.get(end)?.live !== 1 || chain.some(retires)) continue
      return selectTag(this.db, asShortId(end), true)
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
      params.push(iconToNullableColumn(patch.icon))
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
        // A name the tag has again is no longer retired.
        const nextKeys = new Set(next.map(foldCase))
        const retired = tag.retired_names.filter((name) => !nextKeys.has(foldCase(name)))
        if (retired.length !== tag.retired_names.length) {
          sets.unshift('retired_names = ?')
          params.unshift(jsonArrayToColumn(retired))
        }
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
   * dates and currency) where the source and the target both have a value and the values
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
   * nothing is changed. Fields of other kinds in `resolved` are ignored. A
   * link (a merchant, a default category) that neither tag had must be a live
   * tag of the right kind, and changed journey dates must be valid; a link
   * either tag already has is not checked again, even to a tag deleted since.
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
        // A currency typed in the merge dialog is stored like a saved one.
        next.currency = journeyCurrencyToColumn(next.currency)
        const changed = fields.filter((field) => !sameDetail(next[field], into[field]))
        // Only a link on neither side is checked: one either tag already has
        // may point to a tag deleted since, and the source's fills the
        // target's empty field all the same (decisions §2.5).
        await assertDetailLinks(tx, target.kind, next, into, from)
        if (changed.includes('start_date') || changed.includes('end_date')) {
          assertJourneyDates(next)
        }
        if (changed.includes('currency')) assertJourneyCurrency(next.currency)
        if (changed.length > 0) {
          await writeDetailValues(tx, targetId, target.kind, next, now)
        }
      }

      await redirectTagReferences(tx, sourceId, targetId, { bump: true, now })

      const added = namesAddedByMerge(source, target)
      const synonyms = [...target.synonyms, ...added]
      // A name the source retired stays retired on the target, unless the
      // target still has it: as a name, or through a tag merged into it.
      const kindRows = await tx.exec<TagRow>('SELECT * FROM tags WHERE kind = ?', [target.kind])
      const targetMerged = mergedNames(target, kindRows.map(rowToTag))
      const retired = retiredAfterMerge(target, source, synonyms, targetMerged)
      if (added.length > 0 || JSON.stringify(retired) !== JSON.stringify(target.retired_names)) {
        await tx.run(
          'UPDATE tags SET synonyms = ?, retired_names = ?, updated_at_utc = ? WHERE id = ?',
          [jsonArrayToColumn(synonyms), jsonArrayToColumn(retired), now, targetId],
        )
      }
      await tx.run(
        `UPDATE tags SET merged_into_id = ?, deleted_at_utc = ?, updated_at_utc = ?
         WHERE id = ?`,
        [targetId, now, now, sourceId],
      )
    })
  }

  /**
   * Archives the live tag: pickers stop offering it, and the Tags page lists
   * it only on request. It stays live — on its transactions and accounts, in
   * reports, found by name, a merge source or target — and its children stay
   * as they are. Archiving an archived tag changes nothing.
   */
  async archive(id: ShortId): Promise<void> {
    await this.setArchived(id, true)
  }

  /** Offers the live tag in pickers again. Unarchiving an active tag changes nothing. */
  async unarchive(id: ShortId): Promise<void> {
    await this.setArchived(id, false)
  }

  private async setArchived(id: ShortId, archived: boolean): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const tag = await liveTagOrThrow(tx, id, 'Tag')
      if ((tag.archived_at_utc !== null) === archived) return
      await tx.run('UPDATE tags SET archived_at_utc = ?, updated_at_utc = ? WHERE id = ?', [
        archived ? now : null,
        now,
        id,
      ])
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
      if (!tag) throw new TagNotFoundError(`Tag ${id} not found`)
      if (tag.merged_into_id !== null) {
        throw new DeletedTagError(
          `"${tag.name}" was merged into another tag and cannot be restored`,
        )
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
