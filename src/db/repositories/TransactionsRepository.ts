import type { Database } from '../Database'
import type { Transaction } from '../types'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
  localMomentFromRow,
  localMomentToColumns,
  moneyFromRow,
  moneyToColumns,
  uuidFromColumn,
  uuidFromNullableColumn,
} from '../columnMappers'
import { newId, type UUID } from '../uuid'

type TransactionRow = {
  id: string
  account_id__from: string | null
  account_id__to: string | null
  amount_value__from: number
  amount_scale__from: number
  amount_currency__from: string
  amount_value__to: number
  amount_scale__to: number
  amount_currency__to: string
  transaction_at_local: string
  transaction_at_zone: string
  date_override_local: string | null
  date_override_zone: string | null
  tags: string
  location_lat: number | null
  location_lon: number | null
  location_id: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type TransactionCreateInput = Omit<
  Transaction,
  'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'
>

type TransactionUpdateInput = Partial<
  Omit<Transaction, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>
>

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: uuidFromColumn(row.id),
    account_id__from: uuidFromNullableColumn(row.account_id__from),
    account_id__to: uuidFromNullableColumn(row.account_id__to),
    amount__from: moneyFromRow('amount__from', {
      amount_value__from: row.amount_value__from,
      amount_scale__from: row.amount_scale__from,
      amount_currency__from: row.amount_currency__from,
    }),
    amount__to: moneyFromRow('amount__to', {
      amount_value__to: row.amount_value__to,
      amount_scale__to: row.amount_scale__to,
      amount_currency__to: row.amount_currency__to,
    }),
    transaction_at: localMomentFromRow('transaction_at', {
      transaction_at_local: row.transaction_at_local,
      transaction_at_zone: row.transaction_at_zone,
    })!,
    date_override: localMomentFromRow('date_override', {
      date_override_local: row.date_override_local,
      date_override_zone: row.date_override_zone,
    }),
    tags: jsonArrayFromColumn<string>(row.tags),
    location_lat: row.location_lat,
    location_lon: row.location_lon,
    location_id: uuidFromNullableColumn(row.location_id),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

export class TransactionsRepository {
  constructor(private db: Database) {}

  async create(input: TransactionCreateInput): Promise<Transaction> {
    const id = newId()
    const now = instantToColumn(new Date())

    const amountFromColumns = moneyToColumns('amount__from', input.amount__from)
    const amountToColumns = moneyToColumns('amount__to', input.amount__to)
    const transactionAtColumns = localMomentToColumns('transaction_at', input.transaction_at)
    const dateOverrideColumns = localMomentToColumns('date_override', input.date_override)
    const tagsJson = jsonArrayToColumn(input.tags)

    await this.db.run(
      `INSERT INTO transactions (
        id,
        account_id__from, account_id__to,
        amount_value__from, amount_scale__from, amount_currency__from,
        amount_value__to, amount_scale__to, amount_currency__to,
        transaction_at_local, transaction_at_zone,
        date_override_local, date_override_zone,
        tags,
        location_lat, location_lon, location_id,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.account_id__from,
        input.account_id__to,
        amountFromColumns.amount_value__from,
        amountFromColumns.amount_scale__from,
        amountFromColumns.amount_currency__from,
        amountToColumns.amount_value__to,
        amountToColumns.amount_scale__to,
        amountToColumns.amount_currency__to,
        transactionAtColumns.transaction_at_local,
        transactionAtColumns.transaction_at_zone,
        dateOverrideColumns.date_override_local,
        dateOverrideColumns.date_override_zone,
        tagsJson,
        input.location_lat,
        input.location_lon,
        input.location_id,
        now,
        now,
      ],
    )

    return (await this.findById(id))!
  }

  async findById(id: UUID): Promise<Transaction | null> {
    const rows = await this.db.exec<TransactionRow>(
      'SELECT * FROM transactions WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToTransaction(rows[0]!)
  }

  async list(): Promise<Transaction[]> {
    const rows = await this.db.exec<TransactionRow>(
      'SELECT * FROM transactions WHERE deleted_at_utc IS NULL ORDER BY transaction_at_local DESC',
    )
    return rows.map(rowToTransaction)
  }

  async listByAccountId(accountId: UUID): Promise<Transaction[]> {
    const rows = await this.db.exec<TransactionRow>(
      `SELECT * FROM transactions
       WHERE deleted_at_utc IS NULL
         AND (account_id__from = ? OR account_id__to = ?)
       ORDER BY transaction_at_local DESC`,
      [accountId, accountId],
    )
    return rows.map(rowToTransaction)
  }

  async update(id: UUID, patch: TransactionUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.account_id__from !== undefined) {
      sets.push('account_id__from = ?')
      params.push(patch.account_id__from)
    }

    if (patch.account_id__to !== undefined) {
      sets.push('account_id__to = ?')
      params.push(patch.account_id__to)
    }

    if (patch.amount__from !== undefined) {
      const moneyColumns = moneyToColumns('amount__from', patch.amount__from)
      sets.push('amount_value__from = ?')
      params.push(moneyColumns.amount_value__from)
      sets.push('amount_scale__from = ?')
      params.push(moneyColumns.amount_scale__from)
      sets.push('amount_currency__from = ?')
      params.push(moneyColumns.amount_currency__from)
    }

    if (patch.amount__to !== undefined) {
      const moneyColumns = moneyToColumns('amount__to', patch.amount__to)
      sets.push('amount_value__to = ?')
      params.push(moneyColumns.amount_value__to)
      sets.push('amount_scale__to = ?')
      params.push(moneyColumns.amount_scale__to)
      sets.push('amount_currency__to = ?')
      params.push(moneyColumns.amount_currency__to)
    }

    if (patch.transaction_at !== undefined) {
      const localMomentColumns = localMomentToColumns('transaction_at', patch.transaction_at)
      sets.push('transaction_at_local = ?')
      params.push(localMomentColumns.transaction_at_local)
      sets.push('transaction_at_zone = ?')
      params.push(localMomentColumns.transaction_at_zone)
    }

    if (patch.date_override !== undefined) {
      const localMomentColumns = localMomentToColumns('date_override', patch.date_override)
      sets.push('date_override_local = ?')
      params.push(localMomentColumns.date_override_local)
      sets.push('date_override_zone = ?')
      params.push(localMomentColumns.date_override_zone)
    }

    if (patch.tags !== undefined) {
      sets.push('tags = ?')
      params.push(jsonArrayToColumn(patch.tags))
    }

    if (patch.location_lat !== undefined) {
      sets.push('location_lat = ?')
      params.push(patch.location_lat)
    }

    if (patch.location_lon !== undefined) {
      sets.push('location_lon = ?')
      params.push(patch.location_lon)
    }

    if (patch.location_id !== undefined) {
      sets.push('location_id = ?')
      params.push(patch.location_id)
    }

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.run(
      `UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`,
      params,
    )
  }

  async softDelete(id: UUID): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run(
      'UPDATE transactions SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
      [now, now, id],
    )
  }
}
