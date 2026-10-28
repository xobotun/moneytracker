import type { Database } from '../Database'
import type { AccountGrouping } from '../types'
import { newShortId, type ShortId } from '../shortId'
import {
  iconFromColumn,
  iconToColumn,
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  shortIdFromColumn,
} from '../columnMappers'

type AccountGroupingRow = {
  id: string
  name: string
  colour: string
  icon: string
  sort_order: number
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

// sort_order is excluded from both inputs: create() appends, reorder() moves.
export type AccountGroupingCreateInput = Omit<
  AccountGrouping,
  'id' | 'sort_order' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'
>

export type AccountGroupingUpdateInput = Partial<AccountGroupingCreateInput>

function rowToAccountGrouping(row: AccountGroupingRow): AccountGrouping {
  return {
    id: shortIdFromColumn(row.id),
    name: row.name,
    colour: row.colour,
    icon: iconFromColumn(row.icon),
    sort_order: row.sort_order,
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

/**
 * Groups of accounts on the accounts page. Membership lives on the account
 * (`accounts.grouping_id`), so an account is in at most one grouping.
 */
export class AccountGroupingsRepository {
  constructor(private db: Database) {}

  async create(input: AccountGroupingCreateInput): Promise<AccountGrouping> {
    const id = newShortId()
    const now = instantToColumn(new Date())
    // The position is computed inside the INSERT, so appending stays atomic.
    await this.db.run(
      `INSERT INTO account_groupings (id, name, colour, icon, sort_order, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM account_groupings), ?, ?)`,
      [id, input.name, input.colour, iconToColumn(input.icon), now, now],
    )
    return (await this.findById(id))!
  }

  async findById(id: ShortId): Promise<AccountGrouping | null> {
    const rows = await this.db.exec<AccountGroupingRow>(
      'SELECT * FROM account_groupings WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToAccountGrouping(rows[0]!)
  }

  async list(): Promise<AccountGrouping[]> {
    const rows = await this.db.exec<AccountGroupingRow>(
      // Ties are possible after a sync merge (two devices appending at once).
      'SELECT * FROM account_groupings WHERE deleted_at_utc IS NULL ORDER BY sort_order, name, id',
    )
    return rows.map(rowToAccountGrouping)
  }

  async update(id: ShortId, patch: AccountGroupingUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.colour !== undefined) {
      sets.push('colour = ?')
      params.push(patch.colour)
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?')
      params.push(iconToColumn(patch.icon))
    }

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.run(`UPDATE account_groupings SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  /**
   * Stores `ids` as the new order of the groupings (first = position 0),
   * writing only the ones whose position changes.
   */
  async reorder(ids: readonly ShortId[]): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await Promise.all(
        ids.map((id, position) =>
          tx.run(
            'UPDATE account_groupings SET sort_order = ?, updated_at_utc = ? WHERE id = ? AND sort_order <> ?',
            [position, now, id, position],
          ),
        ),
      )
    })
  }

  /**
   * Soft-deletes the grouping. Its live accounts leave it in the same
   * transaction and go to the end of the ungrouped accounts, in their order;
   * the accounts themselves are kept.
   */
  async softDelete(id: ShortId): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      const members = await tx.exec<{ id: string }>(
        `SELECT id FROM accounts WHERE grouping_id = ? AND deleted_at_utc IS NULL
         ORDER BY sort_order, name, id`,
        [id],
      )
      const end = await tx.exec<{ next: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM accounts WHERE grouping_id IS NULL',
      )
      const next = end[0]!.next
      await Promise.all(
        members.map((member, i) =>
          tx.run(
            'UPDATE accounts SET grouping_id = NULL, sort_order = ?, updated_at_utc = ? WHERE id = ?',
            [next + i, now, member.id],
          ),
        ),
      )
      await tx.run(
        'UPDATE account_groupings SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
        [now, now, id],
      )
    })
  }
}
