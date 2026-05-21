import type { Database } from '../Database'
import type { ExchangeRate } from '../types'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonObjectFromColumn,
  jsonObjectToColumn,
  uuidFromColumn,
} from '../columnMappers'
import { newId, type UUID } from '../uuid'

type ExchangeRateRow = {
  id: string
  date: string
  base_currency: string
  rates: string
  provider: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type ExchangeRateCreateInput = Omit<ExchangeRate, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>

type ExchangeRateUpdateInput = Partial<Pick<ExchangeRate, 'rates' | 'provider'>>

function rowToExchangeRate(row: ExchangeRateRow): ExchangeRate {
  return {
    id: uuidFromColumn(row.id),
    date: row.date,
    base_currency: row.base_currency,
    rates: jsonObjectFromColumn<number>(row.rates),
    provider: row.provider,
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

export class ExchangeRatesRepository {
  constructor(private db: Database) {}

  async create(input: ExchangeRateCreateInput): Promise<ExchangeRate> {
    const id = newId()
    const now = instantToColumn(new Date())
    await this.db.run(
      `INSERT INTO exchange_rates (id, date, base_currency, rates, provider, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.date,
        input.base_currency,
        jsonObjectToColumn(input.rates),
        input.provider,
        now,
        now,
      ],
    )
    return (await this.findById(id))!
  }

  async findById(id: UUID): Promise<ExchangeRate | null> {
    const rows = await this.db.exec<ExchangeRateRow>(
      'SELECT * FROM exchange_rates WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToExchangeRate(rows[0]!)
  }

  async findRates(date: string, base_currency: string): Promise<ExchangeRate[]> {
    const rows = await this.db.exec<ExchangeRateRow>(
      'SELECT * FROM exchange_rates WHERE date = ? AND base_currency = ? AND deleted_at_utc IS NULL ORDER BY provider',
      [date, base_currency],
    )
    return rows.map(rowToExchangeRate)
  }

  async list(): Promise<ExchangeRate[]> {
    const rows = await this.db.exec<ExchangeRateRow>(
      'SELECT * FROM exchange_rates WHERE deleted_at_utc IS NULL ORDER BY date DESC, base_currency, provider',
    )
    return rows.map(rowToExchangeRate)
  }

  async update(id: UUID, patch: ExchangeRateUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.rates !== undefined) {
      sets.push('rates = ?')
      params.push(jsonObjectToColumn(patch.rates))
    }
    if (patch.provider !== undefined) {
      sets.push('provider = ?')
      params.push(patch.provider)
    }
    if (sets.length === 0) return
    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)
    await this.db.run(`UPDATE exchange_rates SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  async softDelete(id: UUID): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run(
      'UPDATE exchange_rates SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
      [now, now, id],
    )
  }
}
