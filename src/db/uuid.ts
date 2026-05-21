import { v7 } from 'uuid'

/** Generate a UUIDv7. Time-ordered, suitable as a primary key that also sorts chronologically. */
export function newId(): string {
  return v7()
}
