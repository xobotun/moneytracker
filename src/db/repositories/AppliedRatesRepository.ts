import type { Database } from '../Database'
import type { AppliedRate } from '../types'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  uuidFromColumn,
} from '../columnMappers'
import { nameBasedId, type UUID } from '../uuid'
import { MANUAL_PROVIDER } from '@/money/providers'
import type { Resolution } from '@/money/resolveRate'

type AppliedRateRow = {
  id: string
  date: string
  currency_a: string
  currency_b: string
  rate: number | null
  provider: string | null
  via: string | null
  reference_date: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

/**
 * The id is derived from (date, currency_a, currency_b), so each device holds
 * one row per day and pair, and two devices that resolve the same rate merge
 * it as one row. Whether the row is manual is not part of the key: sync lets a
 * manual row win a conflict instead (see ROW_RANK in sync/syncColumns.ts).
 */
export function appliedRateId(date: string, currencyA: string, currencyB: string): UUID {
  return nameBasedId('applied_rates', date, currencyA, currencyB)
}

/** `x` and `y` in alphabetical order, and whether that swapped them. */
function ordered(x: string, y: string): { a: string; b: string; swapped: boolean } {
  return x < y ? { a: x, b: y, swapped: false } : { a: y, b: x, swapped: true }
}

function rowToAppliedRate(row: AppliedRateRow): AppliedRate {
  return {
    id: uuidFromColumn(row.id),
    date: row.date,
    currency_a: row.currency_a,
    currency_b: row.currency_b,
    rate: row.rate,
    provider: row.provider,
    via: row.via,
    reference_date: row.reference_date,
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

export interface SaveAutoInput {
  date: string
  x: string
  y: string
  /** The rate x → y, or null when nothing was found. */
  resolution: Resolution | null
}

/**
 * Rates the app applies, one per day and currency pair. Callers name the pair
 * in either order; rows keep it alphabetical (currency_a < currency_b) and
 * the rate as units of currency_b per 1 currency_a.
 */
export class AppliedRatesRepository {
  constructor(private db: Database) {}

  async find(date: string, x: string, y: string): Promise<AppliedRate | null> {
    const { a, b } = ordered(x, y)
    const rows = await this.db.exec<AppliedRateRow>(
      'SELECT * FROM applied_rates WHERE id = ? AND deleted_at_utc IS NULL',
      [appliedRateId(date, a, b)],
    )
    return rows.length === 0 ? null : rowToAppliedRate(rows[0]!)
  }

  async listForDate(date: string): Promise<AppliedRate[]> {
    const rows = await this.db.exec<AppliedRateRow>(
      'SELECT * FROM applied_rates WHERE date = ? AND deleted_at_utc IS NULL ORDER BY currency_a, currency_b',
      [date],
    )
    return rows.map(rowToAppliedRate)
  }

  /** The app's own (not manual) live rows of `sinceDate` and later. */
  async listAuto(sinceDate: string): Promise<AppliedRate[]> {
    const rows = await this.db.exec<AppliedRateRow>(
      `SELECT * FROM applied_rates
       WHERE date >= ? AND deleted_at_utc IS NULL AND provider IS NOT ?
       ORDER BY date, currency_a, currency_b`,
      [sinceDate, MANUAL_PROVIDER],
    )
    return rows.map(rowToAppliedRate)
  }

  /**
   * Stores the app's resolution for the day and pair. Never replaces a manual
   * row, and writes nothing when the row would not change. True when written.
   * Whether the resolution is better than the stored one is the caller's call.
   */
  async saveAuto({ date, x, y, resolution }: SaveAutoInput): Promise<boolean> {
    const { a, b, swapped } = ordered(x, y)
    const rate = resolution === null ? null : swapped ? 1 / resolution.rate : resolution.rate
    const now = instantToColumn(new Date())
    const result = await this.db.run(
      `INSERT INTO applied_rates
         (id, date, currency_a, currency_b, rate, provider, via, reference_date, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rate = excluded.rate, provider = excluded.provider, via = excluded.via,
         reference_date = excluded.reference_date, updated_at_utc = excluded.updated_at_utc,
         deleted_at_utc = NULL
       WHERE applied_rates.provider IS NOT ?
         AND (applied_rates.rate IS NOT excluded.rate
           OR applied_rates.provider IS NOT excluded.provider
           OR applied_rates.via IS NOT excluded.via
           OR applied_rates.reference_date IS NOT excluded.reference_date
           OR applied_rates.deleted_at_utc IS NOT NULL)`,
      [
        appliedRateId(date, a, b),
        date,
        a,
        b,
        rate,
        resolution?.provider ?? null,
        resolution?.via ?? null,
        resolution?.referenceDate ?? null,
        now,
        now,
        MANUAL_PROVIDER,
      ],
    )
    return result.changes > 0
  }

  /** The user's own rate for the day: `rate` units of `to` per 1 `from`. */
  async setManual(date: string, from: string, to: string, rate: number): Promise<void> {
    const { a, b, swapped } = ordered(from, to)
    const now = instantToColumn(new Date())
    await this.db.run(
      `INSERT INTO applied_rates
         (id, date, currency_a, currency_b, rate, provider, via, reference_date, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rate = excluded.rate, provider = excluded.provider, via = NULL,
         reference_date = excluded.reference_date, updated_at_utc = excluded.updated_at_utc,
         deleted_at_utc = NULL`,
      [
        appliedRateId(date, a, b),
        date,
        a,
        b,
        swapped ? 1 / rate : rate,
        MANUAL_PROVIDER,
        date,
        now,
        now,
      ],
    )
  }

  /** Drops the override: the row becomes the app's again, empty until resolved. */
  async removeManual(date: string, x: string, y: string): Promise<void> {
    const { a, b } = ordered(x, y)
    await this.db.run(
      `UPDATE applied_rates
       SET rate = NULL, provider = NULL, via = NULL, reference_date = NULL, updated_at_utc = ?
       WHERE id = ? AND provider = ?`,
      [instantToColumn(new Date()), appliedRateId(date, a, b), MANUAL_PROVIDER],
    )
  }
}
