// Typed localStorage helpers shared by every sync-state slot in this
// directory. Three primitives, picked to cover all current needs:
//
//   stringStore        — short scalar identifiers (device name)
//   nullableJsonStore  — structured values that may legitimately be absent
//                        (snapshot caches before the first fetch)
//   jsonStore          — structured values with a sensible default
//                        (provider config). Performs a shallow default-merge
//                        on read so adding new fields to the type later does
//                        not break reads of values persisted by older builds.
//
// All three apply the "moneytracker.sync." key prefix automatically so the
// individual modules read like schema declarations.

const PREFIX = 'moneytracker.sync.'

function fullKey(key: string): string {
  return PREFIX + key
}

/**
 * localStorage.getItem, but storage that cannot be read (private mode,
 * blocked site data: getItem throws a SecurityError) reads as "nothing
 * stored". Sync state is optional; unreadable storage must not break the app.
 */
function readItem(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge a parsed stored value over a fresh deep copy of `defaults`. Nested
 * plain objects (e.g. the per-provider blocks of the provider config) are
 * merged one level deep, and a stored nested value of the wrong shape (null,
 * a string, ...) falls back to the default block instead of replacing it.
 */
function mergeOverDefault<T extends object>(defaults: T, stored: unknown): T {
  const result = structuredClone(defaults) as Record<string, unknown>
  if (!isPlainObject(stored)) return result as T
  for (const [key, value] of Object.entries(stored)) {
    const fallback = result[key]
    if (isPlainObject(fallback)) {
      result[key] = isPlainObject(value) ? { ...fallback, ...value } : fallback
    } else {
      result[key] = value
    }
  }
  return result as T
}

/** Plain-string slot. No JSON envelope — what you save is what you read back. */
export function stringStore(key: string): {
  load(): string | null
  save(value: string): void
  clear(): void
} {
  const k = fullKey(key)
  return {
    load: () => readItem(k),
    save: (value) => {
      localStorage.setItem(k, value)
    },
    clear: () => {
      localStorage.removeItem(k)
    },
  }
}

/**
 * JSON slot that may legitimately be empty. `load()` returns null when nothing
 * has been stored or when the stored payload fails to parse. `save(null)`
 * clears the slot, so callers can persist absence directly.
 */
export function nullableJsonStore<T>(key: string): {
  load(): T | null
  save(value: T | null): void
} {
  const k = fullKey(key)
  return {
    load: () => {
      const raw = readItem(k)
      if (!raw) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    save: (value) => {
      if (value === null) {
        localStorage.removeItem(k)
      } else {
        localStorage.setItem(k, JSON.stringify(value))
      }
    },
  }
}

/**
 * JSON slot that always resolves to a value of T, merging a stored partial
 * over the supplied `defaultValue` (see mergeOverDefault: nested objects are
 * merged one level deep, so a block missing new fields still gets them).
 * Each `load()` returns a fresh deep copy, so mutating the result (e.g.
 * through a v-model on a nested field) cannot leak into the default.
 */
export function jsonStore<T extends object>(
  key: string,
  defaultValue: T,
): {
  load(): T
  save(value: T): void
} {
  const k = fullKey(key)
  return {
    load: () => {
      const raw = readItem(k)
      if (!raw) return mergeOverDefault(defaultValue, null)
      try {
        return mergeOverDefault(defaultValue, JSON.parse(raw))
      } catch {
        return mergeOverDefault(defaultValue, null)
      }
    },
    save: (value) => {
      localStorage.setItem(k, JSON.stringify(value))
    },
  }
}
