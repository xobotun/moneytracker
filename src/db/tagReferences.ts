import type { SqlExecutor } from './Database'
import type { ShortId } from './shortId'
import type { CategoryPart } from './types'
import { sumMoney } from './MoneyAmount'
import {
  categoryPartsFromColumn,
  categoryPartsToColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
} from './columnMappers'

// Every place a tag id is stored, apart from the tags table's own merged_into_id
// (a merge chain is history: sync follows it to its end). Keep these lists in
// step with the schema when a column referencing tags is added.

/** Columns holding a single tag id, as [table, column]. */
const SINGLE_REFERENCES = [
  ['transactions', 'merchant_id'],
  ['transactions', 'location_id'],
  ['transactions', 'journey_id'],
  ['accounts', 'location_id'],
  ['location_details', 'merchant_id'],
  ['merchant_details', 'default_category_id'],
] as const

/** Tables with a `tags` column: a JSON array of plain-tag ids. */
const TAG_LIST_TABLES = ['transactions', 'accounts'] as const

/** The ids with `from` replaced by `to`, each kept once, in its first place. */
function redirectIds(ids: readonly string[], from: ShortId, to: ShortId): string[] {
  return [...new Set(ids.map((id) => (id === from ? to : id)))]
}

/**
 * The parts with `from` replaced by `to`. Two parts of one category become
 * one, in the first one's place, each side summed exactly: the transaction's
 * amounts do not change, so the parts still add up to them.
 */
function redirectParts(parts: readonly CategoryPart[], from: ShortId, to: ShortId): CategoryPart[] {
  const result: CategoryPart[] = []
  for (const part of parts) {
    const category_id = part.category_id === from ? to : part.category_id
    const i = result.findIndex((p) => p.category_id === category_id)
    if (i === -1) {
      result.push({ ...part, category_id })
      continue
    }
    const first = result[i]!
    result[i] = {
      category_id,
      amount__from: sumMoney([first.amount__from, part.amount__from], part.amount__from.currency),
      amount__to: sumMoney([first.amount__to, part.amount__to], part.amount__to.currency),
    }
  }
  return result
}

/**
 * Rewrites every reference to `fromId` into `toId`, in rows of any liveness:
 * the transactions' merchant, location, journey, plain tags and category
 * parts, the accounts' location and plain tags, a location's merchant, a
 * merchant's default category, and the parent of `fromId`'s children. A list
 * that would hold `toId` twice keeps it once; two parts of one category are
 * summed. Writes plain SQL, without the repositories' rules: rows may keep
 * references to deleted tags.
 *
 * `bump`: set `updated_at_utc` to `now` (default: the current instant) on the
 * rewritten rows — a merge is a user edit. Without it, timestamps stay, as
 * for sync repairs that every device computes alike.
 */
export async function redirectTagReferences(
  tx: SqlExecutor,
  fromId: ShortId,
  toId: ShortId,
  opts: { bump: boolean; now?: string },
): Promise<void> {
  if (fromId === toId) return
  const now = opts.now ?? instantToColumn(new Date())
  const bumpSql = opts.bump ? ', updated_at_utc = ?' : ''
  const bumpParams = opts.bump ? [now] : []

  for (const [table, column] of SINGLE_REFERENCES) {
    await tx.run(`UPDATE ${table} SET ${column} = ?${bumpSql} WHERE ${column} = ?`, [
      toId,
      ...bumpParams,
      fromId,
    ])
  }

  // The children move to the target. The target itself is left alone: sync can
  // make it a child of the source (one device moves Y under X, another merges
  // X into Y), and a tag cannot be its own parent. It keeps the merged source
  // as its parent, which the sync repair has to lift.
  await tx.run(`UPDATE tags SET parent_id = ?${bumpSql} WHERE parent_id = ? AND id <> ?`, [
    toId,
    ...bumpParams,
    fromId,
    toId,
  ])

  // JSON columns: rewritten here, then written back in one statement per
  // column (each awaited call into the database is costly).
  const writeBack = async (
    table: string,
    column: string,
    rows: { id: string; value: string }[],
  ) => {
    if (rows.length === 0) return
    await tx.run(
      `UPDATE ${table} SET ${column} = json_extract(rewritten.value, '$.value')${bumpSql}
       FROM json_each(?) AS rewritten
       WHERE ${table}.id = json_extract(rewritten.value, '$.id')`,
      [...bumpParams, JSON.stringify(rows)],
    )
  }

  for (const table of TAG_LIST_TABLES) {
    const rows = await tx.exec<{ id: string; tags: string }>(
      `SELECT id, tags FROM ${table}
       WHERE EXISTS (SELECT 1 FROM json_each(${table}.tags) WHERE value = ?)`,
      [fromId],
    )
    await writeBack(
      table,
      'tags',
      rows.map((row) => ({
        id: row.id,
        value: jsonArrayToColumn(redirectIds(jsonArrayFromColumn<string>(row.tags), fromId, toId)),
      })),
    )
  }

  const rows = await tx.exec<{
    id: string
    categories: string
    amount_currency__from: string
    amount_currency__to: string
  }>(
    `SELECT id, categories, amount_currency__from, amount_currency__to FROM transactions
     WHERE EXISTS (
       SELECT 1 FROM json_each(transactions.categories)
       WHERE json_extract(value, '$.category_id') = ?
     )`,
    [fromId],
  )
  await writeBack(
    'transactions',
    'categories',
    rows.map((row) => {
      const parts = categoryPartsFromColumn(
        row.categories,
        row.amount_currency__from,
        row.amount_currency__to,
      )
      return { id: row.id, value: categoryPartsToColumn(redirectParts(parts, fromId, toId)) }
    }),
  )
}

/**
 * How many live transactions and live accounts use the tag, in any field
 * (merchant, location, journey, plain tags, category parts). Each row counts
 * once, however many of its fields hold the tag.
 */
export async function countTagUsage(db: SqlExecutor, id: ShortId): Promise<number> {
  const rows = await db.exec<{ uses: number }>(
    `SELECT
       (SELECT COUNT(*) FROM transactions t
        WHERE t.deleted_at_utc IS NULL
          AND (t.merchant_id = ?1 OR t.location_id = ?1 OR t.journey_id = ?1
               OR EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?1)
               OR EXISTS (SELECT 1 FROM json_each(t.categories)
                          WHERE json_extract(value, '$.category_id') = ?1)))
     + (SELECT COUNT(*) FROM accounts a
        WHERE a.deleted_at_utc IS NULL
          AND (a.location_id = ?1 OR EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?1)))
       AS uses`,
    [id],
  )
  return rows[0]!.uses
}
