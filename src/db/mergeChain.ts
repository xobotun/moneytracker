/**
 * Where the merge chain from `id` ends: follows `mergedInto` (a tag's
 * `merged_into_id`, null when not merged) to the first tag that is not
 * merged — `id` itself when it is not. Null when the chain goes round a cycle
 * (sync can bring one in until its repair breaks it).
 */
export function mergeChainEnd(
  id: string,
  mergedInto: (id: string) => string | null,
): string | null {
  const seen = new Set<string>()
  for (let current = id; !seen.has(current); ) {
    seen.add(current)
    const next = mergedInto(current)
    if (next === null) return current
    current = next
  }
  return null
}
