import type { ShortId } from '@/db/shortId'
import type { Tag, TagKind } from '@/db/types'
import { effectiveLook, type TagLook } from './look'
import { foldCase } from './otherNames'

// The tags of one kind as the Tags page shows them: a tree, its filter, and
// the path labels the pickers use. Sync can leave a parent loop or a parent
// that is no longer live until its repair runs; every walk here survives both.

export interface TagNode {
  tag: Tag
  children: TagNode[]
}

/** Tags by name (ignoring case and accents), then id: siblings, or any list of tags. */
export function byName(a: Tag, b: Tag): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1)
}

/** The live tags of `kind`, grouped by their live parent of that kind (null: the top level). */
function liveChildren(tags: readonly Tag[], kind: TagKind) {
  const live = tags.filter((t) => t.kind === kind && t.deleted_at_utc === null)
  const ids = new Set(live.map((t) => t.id))
  const children = new Map<ShortId | null, Tag[]>()
  for (const tag of live) {
    const parent = tag.parent_id !== null && ids.has(tag.parent_id) ? tag.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), tag])
  }
  return { live, children }
}

/**
 * The live tags of `kind` as a tree, siblings sorted by name. A tag whose
 * parent is not a live tag of the kind sits at the top level. Tags in a
 * parent loop are reached from nowhere: the first of them by name is lifted
 * to the top level, so each tag shows exactly once.
 */
export function buildTree(tags: readonly Tag[], kind: TagKind): TagNode[] {
  const { live, children } = liveChildren(tags, kind)
  const placed = new Set<ShortId>()
  const node = (tag: Tag): TagNode => {
    placed.add(tag.id)
    return { tag, children: grow(tag.id) }
  }
  const grow = (parent: ShortId): TagNode[] =>
    (children.get(parent) ?? [])
      .filter((t) => !placed.has(t.id))
      .sort(byName)
      .map(node)
  const roots = [...(children.get(null) ?? [])].sort(byName).map(node)
  for (const tag of [...live].sort(byName)) {
    if (!placed.has(tag.id)) roots.push(node(tag))
  }
  return roots.sort((a, b) => byName(a.tag, b.tag))
}

/** The nodes that match, with their ancestors; descendants that do not match are left out. */
export function filterTree(nodes: readonly TagNode[], matches: (tag: Tag) => boolean): TagNode[] {
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, matches)
    return matches(node.tag) || children.length > 0 ? [{ tag: node.tag, children }] : []
  })
}

/** One row of the tree as the page lists it. */
export interface TreeRow {
  tag: Tag
  depth: number
  hasChildren: boolean
  /** Its children are listed (false for a leaf). */
  open: boolean
}

/** The tag a merchant or location links to, as its row shows it. */
export interface RowLink {
  /** What the linked tag is to this one: 'default category', 'merchant'. */
  role: string
  /** Its path, e.g. 'Food › Groceries'. */
  label: string
  look: TagLook
  deleted: boolean
}

/** One detail a detailed row lists (an address, a radius, a date). */
export interface RowFact {
  text: string
  /** Worked out by the app, not typed: shown fainter (CLAUDE.md UI rules). */
  derived: boolean
  /** Says where a derived value comes from. */
  title?: string
}

/** The rows of the tree in order, depth first; the children of a closed tag are left out. */
export function flattenTree(
  nodes: readonly TagNode[],
  isOpen: (id: ShortId) => boolean,
): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (level: readonly TagNode[], depth: number) => {
    for (const { tag, children } of level) {
      const open = children.length > 0 && isOpen(tag.id)
      rows.push({ tag, depth, hasChildren: children.length > 0, open })
      if (open) visit(children, depth + 1)
    }
  }
  visit(nodes, 0)
  return rows
}

/** Whether the tag's name, a synonym or one of its `merged` names contains `query`, ignoring case. */
export function tagMatches(tag: Tag, query: string, merged: readonly string[]): boolean {
  const q = foldCase(query.trim())
  if (q === '') return true
  return [tag.name, ...tag.synonyms, ...merged].some((name) => foldCase(name).includes(q))
}

/** The names from the topmost ancestor down to the tag. */
export function tagPath(tag: Tag, byId: ReadonlyMap<ShortId, Tag>): string[] {
  const path: string[] = []
  const seen = new Set<ShortId>()
  for (let current: Tag | undefined = tag; current && !seen.has(current.id); ) {
    seen.add(current.id)
    path.unshift(current.name)
    current = current.parent_id === null ? undefined : byId.get(current.parent_id)
  }
  return path
}

export function pathLabel(path: readonly string[]): string {
  return path.join(' › ')
}

/** The tag and its live descendants: where it cannot be moved or merged into. */
export function subtreeIds(id: ShortId, tags: readonly Tag[]): Set<ShortId> {
  const tag = tags.find((t) => t.id === id)
  const children = tag ? liveChildren(tags, tag.kind).children : new Map<ShortId | null, Tag[]>()
  const ids = new Set<ShortId>([id])
  const visit = (parent: ShortId) => {
    for (const child of children.get(parent) ?? []) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      visit(child.id)
    }
  }
  visit(id)
  return ids
}

/** A tag as a picker lists it: its path, and the icon and colour it shows. */
export interface TagOption extends TagLook {
  id: ShortId
  label: string
}

/** The live tags of `kind` other than `exclude` for a picker, labelled by their path, sorted by it. */
export function tagOptions(
  tags: readonly Tag[],
  kind: TagKind,
  exclude: ReadonlySet<ShortId> = new Set(),
): TagOption[] {
  const byId = new Map(tags.map((t) => [t.id, t]))
  return tags
    .filter((t) => t.kind === kind && t.deleted_at_utc === null && !exclude.has(t.id))
    .map((t) => {
      return { id: t.id, label: pathLabel(tagPath(t, byId)), ...effectiveLook(t, byId) }
    })
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}
