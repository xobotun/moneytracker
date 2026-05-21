import { v7 } from 'uuid'

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

/** Adopt an existing string as a UUID (trust-the-caller cast, no validation). */
export function asUuid(value: string): UUID {
  return value as UUID
}
