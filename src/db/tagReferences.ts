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

/** Where references move: each tag id to the id that replaces it. */
export type TagRedirects = ReadonlyMap<ShortId, ShortId>

/** The ids, each redirected, each kept once, in its first place. */
function redirectIds(ids: readonly ShortId[], redirects: TagRedirects): ShortId[] {
  return [...new Set(ids.map((id) => redirects.get(id) ?? id))]
}

/**
 * The parts, each category redirected. Two parts of one category become one,
 * in the first one's place, each side summed exactly: the transaction's
 * amounts do not change, so the parts still add up to them.
 */
function redirectParts(parts: readonly CategoryPart[], redirects: TagRedirects): CategoryPart[] {
  const result: CategoryPart[] = []
  for (const part of parts) {
    const category_id = redirects.get(part.category_id) ?? part.category_id
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
  await redirectTagReferencesByMap(tx, new Map([[fromId, toId]]), opts)
}

/**
 * `redirectTagReferences` for many tags at once: every reference to a key of
 * `redirects` moves to its value (the values are final — not redirected
 * again). Runs the same statements whatever the number of redirects: one per
 * single-id column, a read and a write per JSON column.
 *
 * A row whose JSON column is valid JSON but not a list of ids / parts cannot
 * be rewritten: it is skipped and left as it is (with a warning), so one
 * malformed row does not block every merge and sync.
 */
export async function redirectTagReferencesByMap(
  tx: SqlExecutor,
  redirects: TagRedirects,
  opts: { bump: boolean; now?: string },
): Promise<void> {
  const map = new Map([...redirects].filter(([from, to]) => from !== to))
  if (map.size === 0) return
  const now = opts.now ?? instantToColumn(new Date())
  const bumpSql = opts.bump ? ', updated_at_utc = ?' : ''
  const bumpParams = opts.bump ? [now] : []
  // One JSON object { from: to } — `json_each` reads it as rows (key, value).
  const redirectsJson = JSON.stringify(Object.fromEntries(map))

  for (const [table, column] of SINGLE_REFERENCES) {
    await tx.run(
      `UPDATE ${table} SET ${column} = redirect.value${bumpSql}
       FROM json_each(?) AS redirect
       WHERE ${table}.${column} = redirect.key`,
      [...bumpParams, redirectsJson],
    )
  }

  // The children move to the target. The target itself is left alone: sync can
  // make it a child of the source (one device moves Y under X, another merges
  // X into Y), and a tag cannot be its own parent. It keeps the merged source
  // as its parent, which the sync repair has to lift.
  await tx.run(
    `UPDATE tags SET parent_id = redirect.value${bumpSql}
     FROM json_each(?) AS redirect
     WHERE tags.parent_id = redirect.key AND tags.id <> redirect.value`,
    [...bumpParams, redirectsJson],
  )

  // JSON columns: rewritten here, then written back in one statement per
  // column (each awaited call into the database is costly).
  const writeBack = async <R extends { id: string }>(
    table: string,
    column: string,
    rows: R[],
    rewrite: (row: R) => string,
  ) => {
    const rewritten: { id: string; value: string }[] = []
    for (const row of rows) {
      try {
        rewritten.push({ id: row.id, value: rewrite(row) })
      } catch (e) {
        console.warn(`Left ${table}.${column} of ${row.id} as it is: not a valid list.`, e)
      }
    }
    if (rewritten.length === 0) return
    await tx.run(
      `UPDATE ${table} SET ${column} = json_extract(rewritten.value, '$.value')${bumpSql}
       FROM json_each(?) AS rewritten
       WHERE ${table}.id = json_extract(rewritten.value, '$.id')`,
      [...bumpParams, JSON.stringify(rewritten)],
    )
  }

  for (const table of TAG_LIST_TABLES) {
    const rows = await tx.exec<{ id: string; tags: string }>(
      `SELECT id, tags FROM ${table}
       WHERE json_type(${table}.tags) = 'array'
         AND EXISTS (SELECT 1 FROM json_each(${table}.tags) AS element
                     WHERE element.value IN (SELECT key FROM json_each(?)))`,
      [redirectsJson],
    )
    await writeBack(table, 'tags', rows, (row) =>
      jsonArrayToColumn(redirectIds(jsonArrayFromColumn<ShortId>(row.tags), map)),
    )
  }

  // The element-type check keeps json_extract off elements that are not
  // objects: on a bare string it would fail the whole statement.
  const rows = await tx.exec<{
    id: string
    categories: string
    amount_currency__from: string
    amount_currency__to: string
  }>(
    `SELECT id, categories, amount_currency__from, amount_currency__to FROM transactions
     WHERE json_type(transactions.categories) = 'array'
       AND EXISTS (
         SELECT 1 FROM json_each(transactions.categories) AS element
         WHERE CASE element.type WHEN 'object' THEN json_extract(element.value, '$.category_id') END
               IN (SELECT key FROM json_each(?))
       )`,
    [redirectsJson],
  )
  await writeBack('transactions', 'categories', rows, (row) => {
    const parts = categoryPartsFromColumn(
      row.categories,
      row.amount_currency__from,
      row.amount_currency__to,
    )
    return categoryPartsToColumn(redirectParts(parts, map))
  })
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
