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

/** Plain-string slot. No JSON envelope — what you save is what you read back. */
export function stringStore(key: string): {
  load(): string | null
  save(value: string): void
  clear(): void
} {
  const k = fullKey(key)
  return {
    load: () => localStorage.getItem(k),
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
      const raw = localStorage.getItem(k)
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
 * over the supplied `defaultValue`. The merge is shallow — sufficient for the
 * provider-config use case where missing top-level fields are the realistic
 * forward-compatibility concern. Each `load()` returns a fresh copy so that
 * mutating the result cannot leak into the default or into other readers.
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
      const raw = localStorage.getItem(k)
      if (!raw) return { ...defaultValue }
      try {
        return { ...defaultValue, ...(JSON.parse(raw) as Partial<T>) }
      } catch {
        return { ...defaultValue }
      }
    },
    save: (value) => {
      localStorage.setItem(k, JSON.stringify(value))
    },
  }
}
