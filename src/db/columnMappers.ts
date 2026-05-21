import { type MoneyAmount, moneyAmount } from './MoneyAmount'
import { type LocalMoment, localMoment } from './LocalMoment'
import { type UUID, asUuid } from './uuid'

// ---------- MoneyAmount ↔ three columns ----------

export function moneyToColumns(
  prefix: string,
  m: MoneyAmount,
): Record<string, number | string> {
  const { base, suffix } = splitDiscriminator(prefix)
  return {
    [`${base}_value${suffix}`]: m.value,
    [`${base}_scale${suffix}`]: m.scale,
    [`${base}_currency${suffix}`]: m.currency,
  }
}

export function moneyFromRow(prefix: string, row: Record<string, unknown>): MoneyAmount {
  const { base, suffix } = splitDiscriminator(prefix)
  return moneyAmount(
    row[`${base}_value${suffix}`] as number,
    row[`${base}_scale${suffix}`] as number,
    row[`${base}_currency${suffix}`] as string,
  )
}

// ---------- LocalMoment ↔ two columns (nullable as a pair) ----------

export function localMomentToColumns(
  prefix: string,
  lm: LocalMoment | null,
): Record<string, string | null> {
  return {
    [`${prefix}_local`]: lm?.local ?? null,
    [`${prefix}_zone`]: lm?.zone ?? null,
  }
}

export function localMomentFromRow(prefix: string, row: Record<string, unknown>): LocalMoment | null {
  const local = row[`${prefix}_local`] as string | null
  const zone = row[`${prefix}_zone`] as string | null
  if (local === null && zone === null) return null
  if (local === null || zone === null) {
    throw new Error(`Inconsistent LocalMoment in column ${prefix}_local/${prefix}_zone — one is null, the other is not`)
  }
  return localMoment(local, zone)
}

// ---------- JSON array column ----------

export function jsonArrayToColumn<T>(arr: T[]): string {
  return JSON.stringify(arr)
}

export function jsonArrayFromColumn<T>(text: string): T[] {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array')
  return parsed as T[]
}

// ---------- JSON object column ----------

export function jsonObjectToColumn<V>(obj: Record<string, V>): string {
  return JSON.stringify(obj)
}

export function jsonObjectFromColumn<V>(text: string): Record<string, V> {
  const parsed = JSON.parse(text) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object')
  }
  return parsed as Record<string, V>
}

// ---------- Date (Instant) ↔ ISO 8601 UTC TEXT column ----------
//
// SQLite stores `_utc` timestamps as ISO 8601 TEXT (e.g. '2026-03-15T14:30:00.000Z').
// Domain entities expose them as `Date` (the JS equivalent of java.time.Instant).
// Use these helpers at the repository boundary.

export function instantToColumn(d: Date): string {
  return d.toISOString()
}

export function instantToNullableColumn(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

export function instantFromColumn(text: string): Date {
  return new Date(text)
}

export function instantFromNullableColumn(text: string | null): Date | null {
  return text === null ? null : new Date(text)
}

// ---------- UUID ↔ TEXT column ----------
//
// SQLite stores UUIDv7 ids as plain TEXT. Domain entities expose them as the
// branded `UUID` type so that raw strings cannot be mistakenly passed where a
// UUID is expected. The runtime representation is unchanged.

export function uuidFromColumn(text: string): UUID {
  return asUuid(text)
}

export function uuidFromNullableColumn(text: string | null): UUID | null {
  return text === null ? null : asUuid(text)
}

// ---------- helpers ----------

/**
 * Split a prefix into a base and an optional `__discriminator` suffix.
 *
 * Examples:
 *   'balance'         → { base: 'balance',  suffix: '' }
 *   'amount__from'    → { base: 'amount',   suffix: '__from' }
 */
function splitDiscriminator(prefix: string): { base: string; suffix: string } {
  const idx = prefix.indexOf('__')
  if (idx === -1) return { base: prefix, suffix: '' }
  return { base: prefix.slice(0, idx), suffix: prefix.slice(idx) }
}
