import { mergeChainEnd } from '@/db/mergeChain'
import type { ShortId } from '@/db/shortId'
import type { Tag } from '@/db/types'

// A tag's other names: the synonyms it is also found by, and the names of the
// tags merged into it (decisions §2.5). A merge copies the source's names
// into the target's synonyms, and the lookup also finds a name on the merged
// tag itself (sync does not copy names along a chain merged on two devices).
// A removed merged name therefore goes in the live tag's `retired_names`:
// edits to a merged tag's own row never sync.

/** Names are compared ignoring case, in a way that also works beyond ASCII (SQLite's lower() does not). */
export function foldCase(name: string): string {
  return name.toLocaleLowerCase()
}

/** `names` without repeats ignoring case (the first spelling stays) or the names in `without`. */
function distinct(names: readonly string[], without: readonly string[] = []): string[] {
  const seen = new Set(without.map(foldCase))
  return names.filter((name) => {
    const key = foldCase(name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The names and synonyms of the merged tags whose merge chain ends at `id`,
 * in `tags` order, each once. A chain that runs round a cycle ends nowhere.
 */
export function carriedNames(id: ShortId, tags: readonly Tag[]): string[] {
  const mergedInto = new Map<string, string | null>(tags.map((t) => [t.id, t.merged_into_id]))
  const names = tags
    .filter((t) => t.merged_into_id !== null)
    .filter((t) => mergeChainEnd(t.id, (at) => mergedInto.get(at) ?? null) === id)
    .flatMap((t) => [t.name, ...t.synonyms])
  return distinct(names)
}

/** The names shown as merged on `tag`: its carried names other than its name, synonyms and retired names. */
export function mergedNames(tag: Tag, tags: readonly Tag[]): string[] {
  return distinct(carriedNames(tag.id, tags), [tag.name, ...tag.synonyms, ...tag.retired_names])
}

/** `mergedNames` of every tag that has any, in one pass over the merged tags. */
export function mergedNamesByTag(tags: readonly Tag[]): Map<ShortId, string[]> {
  const mergedInto = new Map<string, string | null>(tags.map((t) => [t.id, t.merged_into_id]))
  const carried = new Map<string, string[]>()
  for (const t of tags) {
    if (t.merged_into_id === null) continue
    const end = mergeChainEnd(t.id, (at) => mergedInto.get(at) ?? null)
    if (end !== null) carried.set(end, [...(carried.get(end) ?? []), t.name, ...t.synonyms])
  }
  const byTag = new Map<ShortId, string[]>()
  for (const t of tags) {
    const names = carried.get(t.id)
    if (names) byTag.set(t.id, distinct(names, [t.name, ...t.synonyms, ...t.retired_names]))
  }
  return byTag
}

/**
 * The names a merge adds to the target's synonyms: the source's name and
 * synonyms, except those the target already has as its name or a synonym
 * (ignoring case; the first spelling stays).
 */
export function namesAddedByMerge(
  source: Pick<Tag, 'name' | 'synonyms'>,
  target: Pick<Tag, 'name' | 'synonyms'>,
): string[] {
  return distinct([source.name, ...source.synonyms], [target.name, ...target.synonyms])
}

/**
 * The names that find `target` once `source` is merged into it and do not
 * yet, as the merge warning lists them: the source's name and synonyms, then
 * its merged names (the lookup follows the merge chain on to the target),
 * each once, without the names the target has — its name, synonyms and
 * merged names (ignoring case; the first spelling stays). A merged name the
 * target retired stays retired after the merge (`retiredAfterMerge`), so it
 * is left out too; the source's own names are added as synonyms and so are
 * found even when the target retired them.
 */
export function namesFindingTargetAfterMerge(
  source: Tag,
  target: Tag,
  tags: readonly Tag[],
): string[] {
  const has = [target.name, ...target.synonyms, ...mergedNames(target, tags)]
  const own = distinct([source.name, ...source.synonyms], has)
  const earlier = distinct(mergedNames(source, tags), [...has, ...target.retired_names, ...own])
  return [...own, ...earlier]
}

/**
 * The retired names a merge target keeps: its own and the source's, except
 * the names it still has after the merge — its name, its `synonyms` then and
 * its `merged` names (what tags merged into it carry and it did not retire).
 */
export function retiredAfterMerge(
  target: Pick<Tag, 'name' | 'retired_names'>,
  source: Pick<Tag, 'retired_names'>,
  synonyms: readonly string[],
  merged: readonly string[],
): string[] {
  return distinct(
    [...target.retired_names, ...source.retired_names],
    [target.name, ...synonyms, ...merged],
  )
}

/**
 * What a tag stores when the user keeps `kept` as its other names (`carried`:
 * its `carriedNames`). Kept names are cleaned like `cleanOtherNames`. A kept
 * merged name that is not a synonym stays one that only the merged tag holds;
 * the other kept names are the synonyms. A removed name that a merged tag
 * carries is retired, and a kept one is never retired.
 */
export function applyOtherNames(
  tag: Pick<Tag, 'name' | 'synonyms' | 'retired_names'>,
  carried: readonly string[],
  kept: readonly string[],
): { synonyms: string[]; retired_names: string[] } {
  const clean = cleanOtherNames(tag.name, kept)
  const keptKeys = new Set(clean.map(foldCase))
  const synonymKeys = new Set(tag.synonyms.map(foldCase))
  const mergedOnly = distinct(carried, [tag.name, ...tag.synonyms, ...tag.retired_names])
  const mergedOnlyKeys = new Set(mergedOnly.map(foldCase))
  const carriedKeys = new Set(carried.map(foldCase))
  const removed = [...tag.synonyms, ...mergedOnly].filter((name) => !keptKeys.has(foldCase(name)))
  return {
    synonyms: clean.filter(
      (name) => synonymKeys.has(foldCase(name)) || !mergedOnlyKeys.has(foldCase(name)),
    ),
    retired_names: distinct(
      [...tag.retired_names, ...removed.filter((name) => carriedKeys.has(foldCase(name)))],
      [tag.name, ...clean],
    ),
  }
}

/**
 * The other names to store for a tag called `name`: trimmed, without empty
 * ones, the main name, or repeats (ignoring case; the first spelling stays).
 */
export function cleanOtherNames(name: string, names: readonly string[]): string[] {
  const seen = new Set([foldCase(name.trim())])
  const clean: string[] = []
  for (const raw of names) {
    const other = raw.trim()
    const key = foldCase(other)
    if (other === '' || seen.has(key)) continue
    seen.add(key)
    clean.push(other)
  }
  return clean
}

/** `names` with `name` added at the end, unless it is there already (ignoring case). */
export function withOtherName(names: readonly string[], name: string): string[] {
  const key = foldCase(name.trim())
  return names.some((n) => foldCase(n.trim()) === key) ? [...names] : [...names, name.trim()]
}

/**
 * Whether renaming `before` to `after` looks like fixing a typo, so the old
 * name is not worth keeping as another one: both names at least 3
 * characters, at most two edits apart ignoring case — a character added,
 * dropped or changed, or two neighbours swapped (Damerau–Levenshtein, in its
 * optimal string alignment form).
 */
export function looksLikeTypoFix(before: string, after: string): boolean {
  const a = Array.from(foldCase(before.trim()))
  const b = Array.from(foldCase(after.trim()))
  if (a.length < 3 || b.length < 3) return false
  if (Math.abs(a.length - b.length) > 2) return false
  return editDistance(a, b) <= 2
}

/** The optimal string alignment distance between two lists of characters. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  // d[i][j]: the distance between the first i characters of a and the first j of b.
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1)
      }
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}
