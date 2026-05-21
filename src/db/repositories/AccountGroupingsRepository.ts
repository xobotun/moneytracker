import type { Database } from '../Database'
import type { AccountGrouping } from '../types'
import { newId } from '../uuid'
import { jsonArrayToColumn, jsonArrayFromColumn } from '../columnMappers'

interface AccountGroupingRow {
  id: string
  name: string
  colour: string
  icon: string
  accounts_ids: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type AccountGroupingCreateInput = Omit<AccountGrouping, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>

type AccountGroupingUpdateInput = Partial<
  Omit<AccountGrouping, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>
>

function rowToAccountGrouping(row: AccountGroupingRow): AccountGrouping {
  return {
    id: row.id,
    name: row.name,
    colour: row.colour,
    icon: row.icon,
    accounts_ids: jsonArrayFromColumn<string>(row.accounts_ids),
    created_at_utc: row.created_at_utc,
    updated_at_utc: row.updated_at_utc,
    deleted_at_utc: row.deleted_at_utc,
  }
}

export class AccountGroupingsRepository {
  constructor(private db: Database) {}

  async create(input: AccountGroupingCreateInput): Promise<AccountGrouping> {
    const id = newId()
    const now = new Date().toISOString()
    await this.db.run(
      `INSERT INTO account_groupings (id, name, colour, icon, accounts_ids, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.colour,
        input.icon,
        jsonArrayToColumn(input.accounts_ids),
        now,
        now,
      ],
    )
    return (await this.findById(id))!
  }

  async findById(id: string): Promise<AccountGrouping | null> {
    const rows = await this.db.exec<AccountGroupingRow>(
      'SELECT * FROM account_groupings WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToAccountGrouping(rows[0]!)
  }

  async list(): Promise<AccountGrouping[]> {
    const rows = await this.db.exec<AccountGroupingRow>(
      'SELECT * FROM account_groupings WHERE deleted_at_utc IS NULL ORDER BY name',
    )
    return rows.map(rowToAccountGrouping)
  }

  async update(id: string, patch: AccountGroupingUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.colour !== undefined) { sets.push('colour = ?'); params.push(patch.colour) }
    if (patch.icon !== undefined) { sets.push('icon = ?'); params.push(patch.icon) }
    if (patch.accounts_ids !== undefined) { sets.push('accounts_ids = ?'); params.push(jsonArrayToColumn(patch.accounts_ids)) }

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(new Date().toISOString())
    params.push(id)

    await this.db.run(`UPDATE account_groupings SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  async softDelete(id: string): Promise<void> {
    const now = new Date().toISOString()
    await this.db.run(
      'UPDATE account_groupings SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
      [now, now, id],
    )
  }
}
