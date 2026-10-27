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

/**
 * The retired names a merge target keeps: its own and the source's, except
 * its names after the merge (`synonyms`: its synonyms then).
 */
export function retiredAfterMerge(
  target: Pick<Tag, 'name' | 'retired_names'>,
  source: Pick<Tag, 'retired_names'>,
  synonyms: readonly string[],
): string[] {
  return distinct([...target.retired_names, ...source.retired_names], [target.name, ...synonyms])
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
