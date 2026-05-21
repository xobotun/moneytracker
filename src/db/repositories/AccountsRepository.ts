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
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type AccountCreateInput = Omit<Account, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>

type AccountUpdateInput = Partial<Omit<Account, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>>

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

    await this.db.run(
      `INSERT INTO accounts (id, name, currency, balance_value, balance_scale, tags, location_id, colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      'SELECT * FROM accounts WHERE deleted_at_utc IS NULL ORDER BY name',
    )
    return rows.map(rowToAccount)
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

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.run(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
  }

  async softDelete(id: UUID): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run(
      'UPDATE accounts SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
      [now, now, id],
    )
  }
}
