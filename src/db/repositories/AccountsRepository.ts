import type { Database, SqlExecutor } from '../Database'
import { recalculateBalances } from '../balances'
import type { Account } from '../types'
import {
  assertListedOnce,
  assertTagReferences,
  plainTagReferences,
  singleReference,
} from './transactionRules'
import {
  booleanFromColumn,
  booleanToColumn,
  iconFromColumn,
  iconToColumn,
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
  moneyFromRow,
  moneyToColumns,
  shortIdFromNullableColumn,
  shortIdFromColumn,
} from '../columnMappers'
import { newShortId, type ShortId } from '../shortId'

type AccountRow = {
  id: string
  name: string
  currency: string
  balance_value: number
  balance_scale: number
  is_cash: number
  tags: string
  location_id: string | null
  colour: string
  icon: string
  grouping_id: string | null
  sort_order: number
  archived_at_utc: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

// sort_order is excluded from both inputs: create() and a grouping change in
// update() append to the end of the group, arrange() moves. archived_at_utc
// too: archive() and unarchive() set it. is_cash may be left out of create()
// (not cash).
export type AccountCreateInput = Omit<
  Account,
  | 'id'
  | 'is_cash'
  | 'sort_order'
  | 'archived_at_utc'
  | 'created_at_utc'
  | 'updated_at_utc'
  | 'deleted_at_utc'
> &
  Partial<Pick<Account, 'is_cash'>>

export type AccountUpdateInput = Partial<AccountCreateInput>

function rowToAccount(row: AccountRow): Account {
  return {
    id: shortIdFromColumn(row.id),
    name: row.name,
    balance: moneyFromRow('balance', {
      balance_value: row.balance_value,
      balance_scale: row.balance_scale,
      balance_currency: row.currency,
    }),
    is_cash: booleanFromColumn(row.is_cash),
    tags: jsonArrayFromColumn<ShortId>(row.tags),
    location_id: shortIdFromNullableColumn(row.location_id),
    colour: row.colour,
    icon: iconFromColumn(row.icon),
    grouping_id: shortIdFromNullableColumn(row.grouping_id),
    sort_order: row.sort_order,
    archived_at_utc: instantFromNullableColumn(row.archived_at_utc),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

type AccountReferences = Pick<Account, 'tags' | 'location_id'>

/**
 * The tag references among `fields` (those given) follow the transaction
 * rules: `tags` are plain tags, each listed once, and `location_id` is a
 * location; each live unless `stored` (the row before the write; null on
 * create) already has it there.
 */
async function assertAccountReferences(
  ex: SqlExecutor,
  fields: Partial<AccountReferences>,
  stored: AccountReferences | null,
): Promise<void> {
  const names = await assertTagReferences(ex, [
    ...plainTagReferences(fields.tags ?? [], stored?.tags ?? null),
    ...singleReference(
      fields.location_id ?? null,
      'location',
      'Location',
      stored?.location_id ?? null,
    ),
  ])
  assertListedOnce(fields.tags ?? [], names, 'Tag', 'a tag is on an account once')
}

export class AccountsRepository {
  constructor(private db: Database) {}

  async create(input: AccountCreateInput): Promise<Account> {
    const id = newShortId()
    const now = instantToColumn(new Date())
    const moneyColumns = moneyToColumns('balance', input.balance)
    const tagsJson = jsonArrayToColumn(input.tags)

    // The position (end of its group) is computed inside the INSERT, in the
    // same transaction as the reference checks. Deleted rows count too:
    // harmless, and simpler. `IS`, not `=`, so NULL (no group) matches NULL.
    await this.db.transaction(async (tx) => {
      await assertAccountReferences(tx, input, null)
      await tx.run(
        `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, is_cash, tags, location_id, colour, icon, grouping_id, sort_order, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM accounts WHERE grouping_id IS ?), ?, ?)`,
        [
          id,
          input.name,
          input.balance.currency,
          moneyColumns.balance_value,
          moneyColumns.balance_scale,
          booleanToColumn(input.is_cash ?? false),
          tagsJson,
          input.location_id,
          input.colour,
          iconToColumn(input.icon),
          input.grouping_id,
          input.grouping_id,
          now,
          now,
        ],
      )
    })

    return (await this.findById(id))!
  }

  async findById(id: ShortId): Promise<Account | null> {
    const rows = await this.db.exec<AccountRow>(
      'SELECT * FROM accounts WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToAccount(rows[0]!)
  }

  async list(): Promise<Account[]> {
    const rows = await this.db.exec<AccountRow>(
      // Ties are possible after a sync merge (two devices appending at once).
      'SELECT * FROM accounts WHERE deleted_at_utc IS NULL ORDER BY sort_order, name, id',
    )
    return rows.map(rowToAccount)
  }

  /**
   * Makes `ids` the accounts of grouping `groupingId` (null = no group), in
   * this order (first = position 0) — reorders within a group and moves
   * accounts between groups alike. Only accounts whose group or position
   * actually changes are written, so a move touches as few rows as possible —
   * fewer rows for the sync merge to reconcile.
   */
  async arrange(groupingId: ShortId | null, ids: readonly ShortId[]): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await Promise.all(
        ids.map((id, position) =>
          tx.run(
            `UPDATE accounts SET grouping_id = ?, sort_order = ?, updated_at_utc = ?
             WHERE id = ? AND (grouping_id IS NOT ? OR sort_order <> ?)`,
            [groupingId, position, now, id, groupingId, position],
          ),
        ),
      )
    })
  }

  async update(id: ShortId, patch: AccountUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.balance !== undefined) {
      const moneyColumns = moneyToColumns('balance', patch.balance)
      sets.push('balance_value = ?')
      params.push(moneyColumns.balance_value)
      sets.push('balance_scale = ?')
      params.push(moneyColumns.balance_scale)
      sets.push('currency = ?')
      params.push(moneyColumns.balance_currency)
    }
    if (patch.is_cash !== undefined) {
      sets.push('is_cash = ?')
      params.push(booleanToColumn(patch.is_cash))
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?')
      params.push(jsonArrayToColumn(patch.tags))
    }
    if (patch.location_id !== undefined) {
      sets.push('location_id = ?')
      params.push(patch.location_id)
    }
    if (patch.colour !== undefined) {
      sets.push('colour = ?')
      params.push(patch.colour)
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?')
      params.push(iconToColumn(patch.icon))
    }
    if (patch.grouping_id !== undefined) {
      // A new group puts the account at its end. SQLite evaluates every SET
      // expression against the row as it was, so the CASE sees the old group.
      sets.push('grouping_id = ?')
      params.push(patch.grouping_id)
      sets.push(
        `sort_order = CASE WHEN grouping_id IS ? THEN sort_order
           ELSE (SELECT COALESCE(MAX(a.sort_order) + 1, 0) FROM accounts a WHERE a.grouping_id IS ?) END`,
      )
      params.push(patch.grouping_id, patch.grouping_id)
    }

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.transaction(async (tx) => {
      // Only the references the patch sets are checked: keeping a deleted
      // tag the account already has is fine, adding one is not.
      if (patch.tags !== undefined || patch.location_id !== undefined) {
        const rows = await tx.exec<{ tags: string; location_id: string | null }>(
          'SELECT tags, location_id FROM accounts WHERE id = ?',
          [id],
        )
        const stored = rows[0]
          ? {
              tags: jsonArrayFromColumn<ShortId>(rows[0].tags),
              location_id: shortIdFromNullableColumn(rows[0].location_id),
            }
          : null
        await assertAccountReferences(tx, patch, stored)
      }
      await tx.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params)
    })
  }

  /**
   * Rebuilds the cached balance of `ids` (all accounts when omitted) from the
   * transactions; returns how many changed. See `recalculateBalances`.
   */
  async recalculateBalances(ids?: readonly ShortId[]): Promise<number> {
    return this.db.transaction((tx) => recalculateBalances(tx, ids))
  }

  /**
   * Archives the live account: it leaves the page and group totals and is
   * listed apart. Its transactions, balance, group and place stay, so
   * unarchiving puts it back where it was. Archiving an archived account
   * changes nothing.
   */
  async archive(id: ShortId): Promise<void> {
    await this.setArchived(id, true)
  }

  /** Brings the live account back into its group and the totals. Unarchiving an active one changes nothing. */
  async unarchive(id: ShortId): Promise<void> {
    await this.setArchived(id, false)
  }

  private async setArchived(id: ShortId, archived: boolean): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const rows = await tx.exec<{ name: string; archived: number; deleted: number }>(
        `SELECT name, archived_at_utc IS NOT NULL AS archived, deleted_at_utc IS NOT NULL AS deleted
         FROM accounts WHERE id = ?`,
        [id],
      )
      const account = rows[0]
      if (!account) throw new Error(`Account ${id} not found`)
      if (account.deleted === 1) throw new Error(`Account "${account.name}" is deleted`)
      if ((account.archived === 1) === archived) return
      await tx.run('UPDATE accounts SET archived_at_utc = ?, updated_at_utc = ? WHERE id = ?', [
        archived ? now : null,
        now,
        id,
      ])
    })
  }

  async softDelete(id: ShortId): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run('UPDATE accounts SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?', [
      now,
      now,
      id,
    ])
  }
}
