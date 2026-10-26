/**
 * A branded string for short random ids: 12 base-62 characters (about 71
 * bits), e.g. `4kQ9xZr2BvLm`. Used for rows that are created rarely and
 * referenced often (tags), so the rows referencing them stay small. Unlike a
 * UUIDv7 it carries no time, so it does not sort chronologically.
 */
export type ShortId = string & { readonly __brand: 'ShortId' }

export const SHORT_ID_LENGTH = 12

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// 248 = 4 × 62, the largest multiple of 62 a byte can hold. Bytes from 248 up
// are discarded: mapping them too would make the first 8 characters likelier.
const REJECT_FROM = 248

/** Generates a short id from the platform's cryptographic random source. */
export function newShortId(): ShortId {
  // A byte is kept with probability 248/256, so twice the length is nearly
  // always enough for one draw.
  const bytes = new Uint8Array(SHORT_ID_LENGTH * 2)
  let id = ''
  while (id.length < SHORT_ID_LENGTH) {
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= REJECT_FROM) continue
      id += ALPHABET[byte % ALPHABET.length]
      if (id.length === SHORT_ID_LENGTH) break
    }
  }
  return id as ShortId
}

/** Adopts an existing string as a short id (trust-the-caller cast, no validation). */
export function asShortId(value: string): ShortId {
  return value as ShortId
}
