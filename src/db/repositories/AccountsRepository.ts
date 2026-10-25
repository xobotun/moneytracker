import type { Database } from '../Database'
import type { Account } from '../types'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
  moneyFromRow,
  moneyToColumns,
  uuidFromColumn,
  uuidFromNullableColumn,
} from '../columnMappers'
import { newId, type UUID } from '../uuid'

type AccountRow = {
  id: string
  name: string
  currency: string
  balance_value: number
  balance_scale: number
  tags: string
  location_id: string | null
  colour: string
  icon: string
  grouping_id: string | null
  sort_order: number
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

// sort_order is excluded from both inputs: create() and a grouping change in
// update() append to the end of the group, arrange() moves.
export type AccountCreateInput = Omit<
  Account,
  'id' | 'sort_order' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'
>

export type AccountUpdateInput = Partial<AccountCreateInput>

function rowToAccount(row: AccountRow): Account {
  return {
    id: uuidFromColumn(row.id),
    name: row.name,
    balance: moneyFromRow('balance', {
      balance_value: row.balance_value,
      balance_scale: row.balance_scale,
      balance_currency: row.currency,
    }),
    tags: jsonArrayFromColumn<string>(row.tags),
    location_id: uuidFromNullableColumn(row.location_id),
    colour: row.colour,
    icon: row.icon,
    grouping_id: uuidFromNullableColumn(row.grouping_id),
    sort_order: row.sort_order,
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

export class AccountsRepository {
  constructor(private db: Database) {}

  async create(input: AccountCreateInput): Promise<Account> {
    const id = newId()
    const now = instantToColumn(new Date())
    const moneyColumns = moneyToColumns('balance', input.balance)
    const tagsJson = jsonArrayToColumn(input.tags)

    // The position (end of its group) is computed inside the INSERT, so
    // appending stays atomic without a transaction. Deleted rows count too:
    // harmless, and simpler. `IS`, not `=`, so NULL (no group) matches NULL.
    await this.db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, tags, location_id, colour, icon, grouping_id, sort_order, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM accounts WHERE grouping_id IS ?), ?, ?)`,
      [
        id,
        input.name,
        input.balance.currency,
        moneyColumns.balance_value,
        moneyColumns.balance_scale,
        tagsJson,
        input.location_id,
        input.colour,
        input.icon,
        input.grouping_id,
        input.grouping_id,
        now,
        now,
      ],
    )

    return (await this.findById(id))!
  }

  async findById(id: UUID): Promise<Account | null> {
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
  async arrange(groupingId: UUID | null, ids: readonly UUID[]): Promise<void> {
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

  async update(id: UUID, patch: AccountUpdateInput): Promise<void> {
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
      params.push(patch.icon)
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

    await this.db.run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  async softDelete(id: UUID): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run('UPDATE accounts SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?', [
      now,
      now,
      id,
    ])
  }
}
