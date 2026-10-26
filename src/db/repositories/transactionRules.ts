import type { SqlExecutor } from '../Database'
import type { TagKind, Transaction } from '../types'
import type { ShortId } from '../shortId'
import { sumMoney, type MoneyAmount } from '../MoneyAmount'
import { PartsSumError, TagKindMismatchError } from '../errors'

/** What the rules look at: a transaction's amounts and its tag references. */
export type TransactionRuleFields = Pick<
  Transaction,
  | 'amount__from'
  | 'amount__to'
  | 'categories'
  | 'merchant_id'
  | 'location_id'
  | 'journey_id'
  | 'tags'
>

type Side = 'from' | 'to'

const SIDES: readonly Side[] = ['from', 'to']

function amountOn(x: { amount__from: MoneyAmount; amount__to: MoneyAmount }, side: Side) {
  return side === 'from' ? x.amount__from : x.amount__to
}

/** Whether two amounts are the same number, whatever their scales (2.01 = 2.010000). */
function sameNumber(a: MoneyAmount, b: MoneyAmount): boolean {
  const scale = Math.max(a.scale, b.scale)
  const units = (m: MoneyAmount) => BigInt(m.value) * 10n ** BigInt(scale - m.scale)
  return units(a) === units(b)
}

/** The amount with every stored decimal, for messages: `2.010000 EUR`. */
function exactText(m: MoneyAmount): string {
  const digits = Math.abs(m.value)
    .toString()
    .padStart(m.scale + 1, '0')
  const whole = digits.slice(0, digits.length - m.scale)
  const decimals = m.scale > 0 ? `.${digits.slice(digits.length - m.scale)}` : ''
  return `${m.value < 0 ? '-' : ''}${whole}${decimals} ${m.currency}`
}

/**
 * The rules on the category parts' amounts (decisions §2.2, §2.4): at least
 * one part, in the transaction's currencies, each side's parts adding up
 * exactly to that side's amount. (Each category once is checked with the
 * references, to name the category.)
 */
function assertParts(t: TransactionRuleFields): void {
  if (t.categories.length === 0) throw new Error('A transaction needs at least one category')
  for (const side of SIDES) {
    const total = amountOn(t, side)
    const amounts = t.categories.map((part) => amountOn(part, side))
    const stranger = amounts.find((a) => a.currency !== total.currency)
    if (stranger) {
      throw new PartsSumError(
        `Category parts on the ${side} side must be in ${total.currency}, like the transaction, not in ${stranger.currency}`,
      )
    }
    const sum = sumMoney(amounts, total.currency)
    if (!sameNumber(sum, total)) {
      throw new PartsSumError(
        `Category parts on the ${side} side add up to ${exactText(sum)}, not to the transaction's ${exactText(total)}`,
      )
    }
  }
}

/** One tag the transaction refers to, and whether the stored row already has it there. */
interface Reference {
  id: ShortId
  kind: TagKind
  role: string
  stored: boolean
}

function referencesOf(t: TransactionRuleFields, stored: TransactionRuleFields | null): Reference[] {
  const single = (id: ShortId | null, kind: TagKind, role: string, storedId: ShortId | null) =>
    id === null ? [] : [{ id, kind, role, stored: storedId === id }]
  return [
    ...t.categories.map((part) => ({
      id: part.category_id,
      kind: 'category' as const,
      role: 'Category',
      stored: stored?.categories.some((s) => s.category_id === part.category_id) ?? false,
    })),
    ...single(t.merchant_id, 'merchant', 'Merchant', stored?.merchant_id ?? null),
    ...single(t.location_id, 'location', 'Location', stored?.location_id ?? null),
    ...single(t.journey_id, 'journey', 'Journey', stored?.journey_id ?? null),
    ...t.tags.map((id) => ({
      id,
      kind: 'tag' as const,
      role: 'Tag',
      stored: stored?.tags.includes(id) ?? false,
    })),
  ]
}

/**
 * Every referenced tag must exist and be of its field's kind, and be live
 * unless the stored row already refers to it there: a deleted tag stays on
 * its transactions (restoring it brings it back), but nothing new can use it.
 * A category takes one part only.
 */
async function assertReferences(
  ex: SqlExecutor,
  t: TransactionRuleFields,
  stored: TransactionRuleFields | null,
): Promise<void> {
  const refs = referencesOf(t, stored)
  const rows = await ex.exec<{
    id: string
    kind: string
    name: string
    deleted_at_utc: string | null
  }>(
    'SELECT id, kind, name, deleted_at_utc FROM tags WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(refs.map((ref) => ref.id))],
  )
  const tags = new Map(rows.map((row) => [row.id, row]))
  for (const ref of refs) {
    const tag = tags.get(ref.id)
    if (!tag) throw new Error(`${ref.role}: tag ${ref.id} not found`)
    if (tag.kind !== ref.kind) {
      throw new TagKindMismatchError(
        `${ref.role}: expected a ${ref.kind}, but "${tag.name}" is a ${tag.kind}`,
      )
    }
    if (tag.deleted_at_utc !== null && !ref.stored) {
      throw new Error(`${ref.role}: "${tag.name}" is deleted`)
    }
  }
  const seen = new Set<ShortId>()
  for (const { category_id } of t.categories) {
    if (seen.has(category_id)) {
      throw new Error(
        `Category: "${tags.get(category_id)!.name}" is there twice; a category takes one part`,
      )
    }
    seen.add(category_id)
  }
}

/**
 * Checks a transaction as it will be written (`t`), against the row stored
 * before the write (`stored`; null on create). Run it inside the write's
 * database transaction, so the tags it reads cannot change before the write.
 */
export async function assertTransactionRules(
  ex: SqlExecutor,
  t: TransactionRuleFields,
  stored: TransactionRuleFields | null,
): Promise<void> {
  assertParts(t)
  await assertReferences(ex, t, stored)
}
