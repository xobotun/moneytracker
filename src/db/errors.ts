import type { TagDetailConflict } from './types'

// Errors the repositories throw when a write would break a domain rule. The UI
// tells them apart by class.

/** An id that is no tag at all (not even a deleted one). */
export class TagNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TagNotFoundError'
  }
}

/**
 * A deleted tag where a live one is required: newly referenced, newly linked
 * from a detail, merged, moved or renamed — or a merged tag being restored.
 */
export class DeletedTagError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeletedTagError'
  }
}

/** A tag was used where another kind is required (a parent, a detail's link). */
export class TagKindMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TagKindMismatchError'
  }
}

/** A name or synonym is already taken among the live tags of the same kind and parent. */
export class DuplicateTagNameError extends Error {
  constructor(readonly tagName: string) {
    super(`A tag named "${tagName}" already exists at this level`)
    this.name = 'DuplicateTagNameError'
  }
}

/** A tag would end up under itself (moved or merged into its own descendant). */
export class TagLoopError extends Error {
  /**
   * @param path tag names from the tag being moved or merged down to the
   *   would-be parent, e.g. `['X', 'A', 'Y']` for moving X under Y where X > A > Y
   */
  constructor(readonly path: string[]) {
    super(`A tag cannot go under its own descendant: ${path.join(' > ')}`)
    this.name = 'TagLoopError'
  }
}

/** A category still used by transactions cannot be deleted, only merged into another one. */
export class CategoryInUseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CategoryInUseError'
  }
}

/** A transaction without category parts: every transaction needs at least one. */
export class NoCategoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoCategoryError'
  }
}

/** The same category or plain tag twice on one row. */
export class DuplicateReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DuplicateReferenceError'
  }
}

/** A category part in another currency than the transaction's amount on that side. */
export class CurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CurrencyMismatchError'
  }
}

/** A transaction's category parts do not add up exactly to its amounts. */
export class PartsSumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartsSumError'
  }
}

/** Malformed tag details: a lone coordinate, a journey date that is no calendar date, an end before the start. */
export class InvalidTagDetailsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTagDetailsError'
  }
}

/** A merge where source and target have different values for the same detail; the caller must resolve them. */
export class MergeConflictError extends Error {
  constructor(readonly conflicts: TagDetailConflict[]) {
    super(`Merging needs a decision for: ${conflicts.map((c) => c.field).join(', ')}`)
    this.name = 'MergeConflictError'
  }
}
