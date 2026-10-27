// A tag's other names: the synonyms it is also found by.

/** Names are compared ignoring case, in a way that also works beyond ASCII (SQLite's lower() does not). */
export function foldCase(name: string): string {
  return name.toLocaleLowerCase()
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
