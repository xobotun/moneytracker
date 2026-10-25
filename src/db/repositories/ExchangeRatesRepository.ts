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
import { nameBasedId, type UUID } from '../uuid'

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

type ExchangeRateCreateInput = Omit<
  ExchangeRate,
  'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'
>

// `provider` (like `date` and `base_currency`) is part of the row's identity —
// see exchangeRateId — so it cannot be changed after creation.
type ExchangeRateUpdateInput = Partial<Pick<ExchangeRate, 'rates'>>

/**
 * The id is derived from (date, base_currency, provider), so there is at most
 * one row per key: a fetch of a publication already held updates that row
 * (`save`). The table is the device-local reference library and is not
 * synced; the rates the app applies live in `applied_rates`.
 */
export function exchangeRateId(date: string, baseCurrency: string, provider: string): UUID {
  return nameBasedId('exchange_rates', date, baseCurrency, provider)
}

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
    const id = exchangeRateId(input.date, input.base_currency, input.provider)
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

  /**
   * Stores a fetched publication: inserts it, or replaces the rates of the row
   * with the same (date, base, provider). False when the stored rates already
   * match.
   */
  async save(input: ExchangeRateCreateInput): Promise<boolean> {
    const now = instantToColumn(new Date())
    const rates = jsonObjectToColumn(input.rates)
    const result = await this.db.run(
      `INSERT INTO exchange_rates (id, date, base_currency, rates, provider, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rates = excluded.rates, updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL
       WHERE exchange_rates.rates IS NOT excluded.rates OR exchange_rates.deleted_at_utc IS NOT NULL`,
      [
        exchangeRateId(input.date, input.base_currency, input.provider),
        input.date,
        input.base_currency,
        rates,
        input.provider,
        now,
        now,
      ],
    )
    return result.changes > 0
  }

  /** Every live row dated `from` … `to`, both included. */
  async listBetween(from: string, to: string): Promise<ExchangeRate[]> {
    const rows = await this.db.exec<ExchangeRateRow>(
      `SELECT * FROM exchange_rates
       WHERE date >= ? AND date <= ? AND deleted_at_utc IS NULL
       ORDER BY date DESC, provider, base_currency`,
      [from, to],
    )
    return rows.map(rowToExchangeRate)
  }

  /** The newest date any live row has, or null when there are none. */
  async newestDate(): Promise<string | null> {
    const rows = await this.db.exec<{ newest: string | null }>(
      'SELECT MAX(date) AS newest FROM exchange_rates WHERE deleted_at_utc IS NULL',
    )
    return rows[0]?.newest ?? null
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
