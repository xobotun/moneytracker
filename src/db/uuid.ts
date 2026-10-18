import { v5, v7 } from 'uuid'

/**
 * A branded string type for UUIDs. Identical to `string` at runtime, but
 * distinct at compile time so plain strings cannot be passed where a UUID
 * is expected. Use {@link newId} to mint a fresh UUID or {@link asUuid} to
 * adopt an existing UUID string from outside the system (DB rows, URL
 * params, deserialized payloads).
 */
export type UUID = string & { readonly __brand: 'UUID' }

/** Generate a UUIDv7. Time-ordered, suitable as a primary key that also sorts chronologically. */
export function newId(): UUID {
  return v7() as UUID
}

/**
 * Namespace for {@link nameBasedId}. Never change it: ids derived from it are
 * persisted and synced, so a new namespace would split every such row in two.
 */
const NAME_BASED_ID_NAMESPACE = 'a0e251d4-54ed-4f58-91f4-8a340471f22f'

/**
 * Derive a stable UUIDv5 from a natural key. The same key yields the same id
 * on every device, so two devices creating "the same" row produce one row
 * that sync merges by primary key instead of two rows that collide.
 */
export function nameBasedId(...keyParts: string[]): UUID {
  // JSON-encode the parts so ('a|b', 'c') and ('a', 'b|c') stay distinct.
  return v5(JSON.stringify(keyParts), NAME_BASED_ID_NAMESPACE) as UUID
}

/** Adopt an existing string as a UUID (trust-the-caller cast, no validation). */
export function asUuid(value: string): UUID {
  return value as UUID
}
