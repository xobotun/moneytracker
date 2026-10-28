import type { Database, SqlExecutor } from '../Database'
import type {
  JourneyDetails,
  LocationDetails,
  MerchantDetails,
  Tag,
  TagDetailField,
  TagDetailValues,
  TagKind,
} from '../types'
import type { ShortId } from '../shortId'
import {
  DeletedTagError,
  InvalidTagDetailsError,
  TagKindMismatchError,
  TagNotFoundError,
} from '../errors'
import { isCalendarDate } from '@/money/dates'
import { currencyCodeError, normaliseCurrencyCode } from '@/format/currency'
import {
  booleanFromColumn,
  booleanToColumn,
  instantToColumn,
  optionalTextToColumn,
  shortIdFromColumn,
  shortIdFromNullableColumn,
} from '../columnMappers'
import { rowToTag, type TagRow } from './TagsRepository'

type LocationDetailsRow = {
  tag_id: string
  address: string | null
  latitude: number | null
  longitude: number | null
  merchant_id: string | null
  radius_metres: number
  auto_match: number
}

type MerchantDetailsRow = {
  tag_id: string
  default_category_id: string | null
  auto_match: number
}

type JourneyDetailsRow = {
  tag_id: string
  start_date: string | null
  end_date: string | null
  currency: string | null
}

/** The radius of a location that sets none: about a shop. */
export const DEFAULT_LOCATION_RADIUS_METRES = 10

/** Mean Earth radius (IUGG), in metres. */
const EARTH_RADIUS_METRES = 6_371_008.8

/** Great-circle distance between two WGS84 points, in metres (haversine formula). */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Throws unless `id` is a tag of the `expected` kind (of any liveness). */
export async function assertKind(
  ex: SqlExecutor,
  id: ShortId,
  expected: TagKind,
  role: string,
): Promise<void> {
  const rows = await ex.exec<{ kind: string; name: string }>(
    'SELECT kind, name FROM tags WHERE id = ?',
    [id],
  )
  const tag = rows[0]
  if (!tag) throw new TagNotFoundError(`${role}: tag ${id} not found`)
  if (tag.kind !== expected) {
    throw new TagKindMismatchError(
      `${role}: expected a ${expected}, but "${tag.name}" is a ${tag.kind}`,
    )
  }
}

async function readLocation(ex: SqlExecutor, id: ShortId): Promise<LocationDetails | null> {
  const rows = await ex.exec<LocationDetailsRow>(
    `SELECT tag_id, address, latitude, longitude, merchant_id, radius_metres, auto_match FROM location_details
     WHERE tag_id = ? AND deleted_at_utc IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return {
    tag_id: shortIdFromColumn(row.tag_id),
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    merchant_id: shortIdFromNullableColumn(row.merchant_id),
    radius_metres: row.radius_metres,
    auto_match: booleanFromColumn(row.auto_match),
  }
}

async function readMerchant(ex: SqlExecutor, id: ShortId): Promise<MerchantDetails | null> {
  const rows = await ex.exec<MerchantDetailsRow>(
    `SELECT tag_id, default_category_id, auto_match FROM merchant_details
     WHERE tag_id = ? AND deleted_at_utc IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return {
    tag_id: shortIdFromColumn(row.tag_id),
    default_category_id: shortIdFromNullableColumn(row.default_category_id),
    auto_match: booleanFromColumn(row.auto_match),
  }
}

async function readJourney(ex: SqlExecutor, id: ShortId): Promise<JourneyDetails | null> {
  const rows = await ex.exec<JourneyDetailsRow>(
    `SELECT tag_id, start_date, end_date, currency FROM journey_details
     WHERE tag_id = ? AND deleted_at_utc IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return {
    tag_id: shortIdFromColumn(row.tag_id),
    start_date: row.start_date,
    end_date: row.end_date,
    currency: row.currency,
  }
}

/** The detail fields each kind of tag has; the other kinds have none. */
export const DETAIL_FIELDS_BY_KIND: Record<TagKind, readonly TagDetailField[]> = {
  location: ['address', 'position', 'merchant_id', 'radius_metres', 'auto_match'],
  merchant: ['default_category_id', 'auto_match'],
  journey: ['start_date', 'end_date', 'currency'],
  category: [],
  tag: [],
}

/** Details with every field empty. */
export function noDetails(): TagDetailValues {
  return {
    address: null,
    position: null,
    merchant_id: null,
    radius_metres: null,
    auto_match: null,
    default_category_id: null,
    start_date: null,
    end_date: null,
    currency: null,
  }
}

/** A tag's live details as one value set; a missing row means every field is null. */
export async function readDetailValues(
  ex: SqlExecutor,
  id: ShortId,
  kind: TagKind,
): Promise<TagDetailValues> {
  const values = noDetails()
  if (kind === 'location') {
    const d = await readLocation(ex, id)
    if (d) {
      values.address = d.address
      // One coordinate alone is no position.
      if (d.latitude !== null && d.longitude !== null) {
        values.position = { latitude: d.latitude, longitude: d.longitude }
      }
      values.merchant_id = d.merchant_id
    }
    values.radius_metres = d?.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES
    values.auto_match = d?.auto_match ?? true
  } else if (kind === 'merchant') {
    const d = await readMerchant(ex, id)
    values.default_category_id = d?.default_category_id ?? null
    values.auto_match = d?.auto_match ?? true
  } else if (kind === 'journey') {
    const d = await readJourney(ex, id)
    values.start_date = d?.start_date ?? null
    values.end_date = d?.end_date ?? null
    values.currency = d?.currency ?? null
  }
  return values
}

type DetailLinks = Pick<TagDetailValues, 'merchant_id' | 'default_category_id'>

/**
 * Checks that the links in `values` that the kind uses are live tags of the
 * right kind (a location's merchant, a merchant's default category). A link
 * equal to the same field of a `known` value set (the details as they are;
 * for a merge, the source's too) is not checked: a deleted tag stays linked
 * (restoring it brings it back), but nothing new can link to it.
 */
export async function assertDetailLinks(
  ex: SqlExecutor,
  kind: TagKind,
  values: DetailLinks,
  ...known: (DetailLinks | null)[]
): Promise<void> {
  const changed = (field: keyof DetailLinks) =>
    values[field] !== null && !known.some((k) => k?.[field] === values[field])
  if (kind === 'location' && changed('merchant_id')) {
    await assertLiveKind(ex, values.merchant_id!, 'merchant', 'A location’s merchant')
  }
  if (kind === 'merchant' && changed('default_category_id')) {
    await assertLiveKind(
      ex,
      values.default_category_id!,
      'category',
      'A merchant’s default category',
    )
  }
}

async function assertLiveKind(
  ex: SqlExecutor,
  id: ShortId,
  expected: TagKind,
  role: string,
): Promise<void> {
  await assertKind(ex, id, expected, role)
  const rows = await ex.exec<{ name: string }>(
    'SELECT name FROM tags WHERE id = ? AND deleted_at_utc IS NOT NULL',
    [id],
  )
  if (rows.length > 0) throw new DeletedTagError(`${role}: "${rows[0]!.name}" is deleted`)
}

/** A location's radius: a whole number of metres, at least 1. */
export function assertLocationRadius(radius: number): void {
  if (!Number.isInteger(radius) || radius < 1) {
    throw new InvalidTagDetailsError(
      `A location's radius must be a whole number of metres, at least 1, not ${radius}`,
    )
  }
}

/** A journey's typed dates: each a calendar date 'YYYY-MM-DD' or null, the start not after the end. */
export function assertJourneyDates(values: Pick<TagDetailValues, 'start_date' | 'end_date'>): void {
  for (const date of [values.start_date, values.end_date]) {
    if (date !== null && !isCalendarDate(date)) {
      throw new InvalidTagDetailsError(
        `A journey date must be a calendar date (YYYY-MM-DD), not "${date}"`,
      )
    }
  }
  if (
    values.start_date !== null &&
    values.end_date !== null &&
    values.start_date > values.end_date
  ) {
    throw new InvalidTagDetailsError(
      `A journey cannot end (${values.end_date}) before it starts (${values.start_date})`,
    )
  }
}

/** A typed journey currency as stored: trimmed and upper-cased; empty is none (inherited). */
export function journeyCurrencyToColumn(currency: string | null): string | null {
  return currency === null ? null : optionalTextToColumn(normaliseCurrencyCode(currency))
}

/** A journey's own currency: null (inherited) or a code as `currencyCodeError` accepts it. */
export function assertJourneyCurrency(currency: string | null): void {
  const error = currency === null ? null : currencyCodeError(currency)
  if (error !== null) {
    throw new InvalidTagDetailsError(`A journey's currency "${currency}" is not valid: ${error}`)
  }
}

/** Upserts the details row of a location, merchant or journey with all of its fields. */
export async function writeDetailValues(
  ex: SqlExecutor,
  id: ShortId,
  kind: TagKind,
  v: TagDetailValues,
  now: string,
): Promise<void> {
  if (kind === 'location') {
    const radius = v.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES
    assertLocationRadius(radius)
    await ex.run(
      `INSERT INTO location_details (tag_id, address, latitude, longitude, merchant_id,
                                     radius_metres, auto_match, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         address = excluded.address, latitude = excluded.latitude,
         longitude = excluded.longitude, merchant_id = excluded.merchant_id,
         radius_metres = excluded.radius_metres,
         auto_match = excluded.auto_match,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [
        id,
        optionalTextToColumn(v.address),
        v.position?.latitude ?? null,
        v.position?.longitude ?? null,
        v.merchant_id,
        radius,
        booleanToColumn(v.auto_match ?? true),
        now,
        now,
      ],
    )
  } else if (kind === 'merchant') {
    await ex.run(
      `INSERT INTO merchant_details (tag_id, default_category_id, auto_match, created_at_utc,
                                     updated_at_utc)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         default_category_id = excluded.default_category_id,
         auto_match = excluded.auto_match,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [id, v.default_category_id, booleanToColumn(v.auto_match ?? true), now, now],
    )
  } else if (kind === 'journey') {
    await ex.run(
      `INSERT INTO journey_details (tag_id, start_date, end_date, currency, created_at_utc,
                                    updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         start_date = excluded.start_date, end_date = excluded.end_date,
         currency = excluded.currency,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [
        id,
        optionalTextToColumn(v.start_date),
        optionalTextToColumn(v.end_date),
        optionalTextToColumn(v.currency),
        now,
        now,
      ],
    )
  }
}

/**
 * A journey's start and end dates ('YYYY-MM-DD'): each the date the user
 * typed (`*Typed`), else derived — the first and the last of the local
 * calendar dates of the journey's live transactions (by their date override
 * when they have one) and of its live journeys below it, including the dates
 * typed on those, so a parent covers its children (decisions §2.7). A deleted
 * journey and everything under it no longer count. Null when there is nothing
 * to derive from. `derivedStart` / `derivedEnd` are the derived ones even
 * where a date is typed: what a reset goes back to.
 */
export interface JourneyDates {
  start: string | null
  end: string | null
  startTyped: boolean
  endTyped: boolean
  derivedStart: string | null
  derivedEnd: string | null
}

// Each transaction counts by its own local date, so the range contains every
// one of them even when their offsets differ ('YYYY-MM-DD' text sorts as
// dates; the full offset-bearing moments would not).
const TRANSACTION_DATE = 'substr(COALESCE(date_override_local, transaction_at_local), 1, 10)'

function journeyDatesFrom(
  typed: { start_date: string | null; end_date: string | null } | null,
  derived: { first_date: string | null; last_date: string | null },
): JourneyDates {
  const start = typed?.start_date ?? null
  const end = typed?.end_date ?? null
  return {
    start: start ?? derived.first_date,
    end: end ?? derived.last_date,
    startTyped: start !== null,
    endTyped: end !== null,
    derivedStart: derived.first_date,
    derivedEnd: derived.last_date,
  }
}

/** The dates of journey `id` (see `JourneyDates`), of any liveness; usable inside a transaction. */
export async function readJourneyDates(ex: SqlExecutor, id: ShortId): Promise<JourneyDates> {
  const typed = await readJourney(ex, id)
  const rows = await ex.exec<{ first_date: string | null; last_date: string | null }>(
    `WITH RECURSIVE journey(id) AS (
       SELECT ?
       UNION
       SELECT t.id FROM tags t JOIN journey j ON t.parent_id = j.id
       WHERE t.deleted_at_utc IS NULL
     ),
     dates(d) AS (
       SELECT ${TRANSACTION_DATE}
       FROM transactions
       WHERE deleted_at_utc IS NULL AND journey_id IN (SELECT id FROM journey)
       UNION ALL
       SELECT start_date FROM journey_details
       WHERE deleted_at_utc IS NULL AND tag_id <> ? AND tag_id IN (SELECT id FROM journey)
       UNION ALL
       SELECT end_date FROM journey_details
       WHERE deleted_at_utc IS NULL AND tag_id <> ? AND tag_id IN (SELECT id FROM journey)
     )
     SELECT MIN(d) AS first_date, MAX(d) AS last_date FROM dates`,
    [id, id, id],
  )
  return journeyDatesFrom(typed, rows[0]!)
}

/**
 * The dates of every live journey, by id (see `JourneyDates`), in one query:
 * each live journey with the live journeys below it (`UNION` stops on a
 * parent loop that sync left), the first and last transaction date of each
 * journey, and the typed dates of the ones below it.
 */
export async function readAllJourneyDates(ex: SqlExecutor): Promise<Map<ShortId, JourneyDates>> {
  const rows = await ex.exec<{
    id: string
    start_date: string | null
    end_date: string | null
    first_date: string | null
    last_date: string | null
  }>(
    `WITH RECURSIVE
     journeys(id) AS (
       SELECT id FROM tags WHERE kind = 'journey' AND deleted_at_utc IS NULL
     ),
     below(top, id) AS (
       SELECT id, id FROM journeys
       UNION
       SELECT b.top, t.id FROM tags t JOIN below b ON t.parent_id = b.id
       WHERE t.deleted_at_utc IS NULL
     ),
     spent(id, first_date, last_date) AS (
       SELECT journey_id, MIN(d), MAX(d)
       FROM (SELECT journey_id, ${TRANSACTION_DATE} AS d FROM transactions
             WHERE deleted_at_utc IS NULL AND journey_id IS NOT NULL)
       GROUP BY journey_id
     ),
     typed(id, start_date, end_date) AS (
       SELECT tag_id, start_date, end_date FROM journey_details WHERE deleted_at_utc IS NULL
     ),
     dates(top, d) AS (
       SELECT b.top, s.first_date FROM below b JOIN spent s ON s.id = b.id
       UNION ALL
       SELECT b.top, s.last_date FROM below b JOIN spent s ON s.id = b.id
       UNION ALL
       SELECT b.top, t.start_date FROM below b JOIN typed t ON t.id = b.id WHERE b.id <> b.top
       UNION ALL
       SELECT b.top, t.end_date FROM below b JOIN typed t ON t.id = b.id WHERE b.id <> b.top
     ),
     derived(id, first_date, last_date) AS (
       SELECT top, MIN(d), MAX(d) FROM dates GROUP BY top
     )
     SELECT j.id AS id, t.start_date AS start_date, t.end_date AS end_date,
            d.first_date AS first_date, d.last_date AS last_date
     FROM journeys j
     LEFT JOIN typed t ON t.id = j.id
     LEFT JOIN derived d ON d.id = j.id`,
  )
  return new Map(
    rows.map((row) => [
      shortIdFromColumn(row.id),
      journeyDatesFrom(row.start_date === null && row.end_date === null ? null : row, {
        first_date: row.first_date ?? null,
        last_date: row.last_date ?? null,
      }),
    ]),
  )
}

/**
 * What only one kind of tag has, in a side table keyed by the tag's id: a
 * location's address, coordinates and merchant; a merchant's default
 * category; a journey's typed dates and currency. Each kind is checked on
 * write.
 */
export class TagDetailsRepository {
  constructor(private db: Database) {}

  /** The tag's details as one value set (all empty for a kind without details). */
  values(id: ShortId, kind: TagKind): Promise<TagDetailValues> {
    return readDetailValues(this.db, id, kind)
  }

  /**
   * The details of every tag that has a live details row, by tag id, as the
   * Tags page lists them (fields of other kinds empty; a tag without a row
   * has none here). One query per kind; a linked tag may be deleted since.
   */
  async detailsByTag(): Promise<Map<ShortId, TagDetailValues>> {
    const live = 'WHERE deleted_at_utc IS NULL'
    const [locations, merchants, journeys] = await Promise.all([
      this.db.exec<LocationDetailsRow>(
        `SELECT tag_id, address, latitude, longitude, merchant_id, radius_metres, auto_match
         FROM location_details ${live}`,
      ),
      this.db.exec<MerchantDetailsRow>(
        `SELECT tag_id, default_category_id, auto_match FROM merchant_details ${live}`,
      ),
      this.db.exec<JourneyDetailsRow>(
        `SELECT tag_id, start_date, end_date, currency FROM journey_details ${live}`,
      ),
    ])
    const byTag = new Map<ShortId, TagDetailValues>()
    for (const row of locations) {
      byTag.set(shortIdFromColumn(row.tag_id), {
        ...noDetails(),
        address: row.address,
        // One coordinate alone is no position.
        position:
          row.latitude !== null && row.longitude !== null
            ? { latitude: row.latitude, longitude: row.longitude }
            : null,
        merchant_id: shortIdFromNullableColumn(row.merchant_id),
        radius_metres: row.radius_metres,
        auto_match: booleanFromColumn(row.auto_match),
      })
    }
    for (const row of merchants) {
      byTag.set(shortIdFromColumn(row.tag_id), {
        ...noDetails(),
        default_category_id: shortIdFromNullableColumn(row.default_category_id),
        auto_match: booleanFromColumn(row.auto_match),
      })
    }
    for (const row of journeys) {
      byTag.set(shortIdFromColumn(row.tag_id), {
        ...noDetails(),
        start_date: row.start_date,
        end_date: row.end_date,
        currency: row.currency,
      })
    }
    return byTag
  }

  getLocation(id: ShortId): Promise<LocationDetails | null> {
    return readLocation(this.db, id)
  }

  /**
   * Stores the details of a location tag: both coordinates or neither,
   * `merchant_id` a merchant, live unless the location already has it, and
   * the radius in whole metres (10 when left out); it matches transactions
   * automatically unless `auto_match` is false.
   */
  async setLocation(
    id: ShortId,
    d: Omit<LocationDetails, 'tag_id' | 'radius_metres' | 'auto_match'> & {
      radius_metres?: number
      auto_match?: boolean
    },
  ): Promise<void> {
    if ((d.latitude === null) !== (d.longitude === null)) {
      throw new InvalidTagDetailsError('A location needs both coordinates or neither')
    }
    const position =
      d.latitude !== null && d.longitude !== null
        ? { latitude: d.latitude, longitude: d.longitude }
        : null
    await this.write(id, 'location', 'Location details', {
      ...noDetails(),
      address: d.address,
      position,
      merchant_id: d.merchant_id,
      radius_metres: d.radius_metres ?? DEFAULT_LOCATION_RADIUS_METRES,
      auto_match: d.auto_match ?? true,
    })
  }

  getMerchant(id: ShortId): Promise<MerchantDetails | null> {
    return readMerchant(this.db, id)
  }

  /**
   * Stores the details of a merchant tag; `default_category_id` must be a
   * category, live unless the merchant already has it. Imported lines naming
   * the merchant get it automatically unless `auto_match` is false.
   */
  async setMerchant(
    id: ShortId,
    d: Omit<MerchantDetails, 'tag_id' | 'auto_match'> & { auto_match?: boolean },
  ): Promise<void> {
    await this.write(id, 'merchant', 'Merchant details', {
      ...noDetails(),
      default_category_id: d.default_category_id,
      auto_match: d.auto_match ?? true,
    })
  }

  getJourney(id: ShortId): Promise<JourneyDetails | null> {
    return readJourney(this.db, id)
  }

  /**
   * Stores the dates typed for a journey tag (null = derived from its
   * transactions): calendar dates 'YYYY-MM-DD', the start not after the end;
   * and its currency (null or left out = inherited from its parent), a code
   * stored trimmed and upper-cased.
   */
  async setJourney(
    id: ShortId,
    d: Omit<JourneyDetails, 'tag_id' | 'currency'> & { currency?: string | null },
  ): Promise<void> {
    assertJourneyDates(d)
    const currency = journeyCurrencyToColumn(d.currency ?? null)
    assertJourneyCurrency(currency)
    await this.write(id, 'journey', 'Journey details', {
      ...noDetails(),
      start_date: d.start_date,
      end_date: d.end_date,
      currency,
    })
  }

  /** Upserts the details of tag `id`, which must be of `kind`, after checking their links. */
  private async write(
    id: ShortId,
    kind: TagKind,
    role: string,
    values: TagDetailValues,
  ): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await assertKind(tx, id, kind, role)
      await assertDetailLinks(tx, kind, values, await readDetailValues(tx, id, kind))
      await writeDetailValues(tx, id, kind, values, now)
    })
  }

  /** A journey's start and end dates (see `JourneyDates`). */
  journeyDates(id: ShortId): Promise<JourneyDates> {
    return readJourneyDates(this.db, id)
  }

  /**
   * The dates of every live journey, by id, in one query: for each, what
   * `journeyDates` gives (the same rules: typed dates win, a parent covers
   * its live children, deleted journeys and what is under them drop out).
   */
  allJourneyDates(): Promise<Map<ShortId, JourneyDates>> {
    return readAllJourneyDates(this.db)
  }

  /**
   * Live locations with coordinates within `radiusMetres` of the point, at
   * most `limit`, the most specific place first. A distance (`metres`) counts
   * to the edge of the location's circle (its own radius), 0 inside it, so a
   * big place matches from anywhere in it. The circles that contain the point
   * come first, the smallest first (a store before the city around it), equal
   * radii by the nearer centre; then the others by distance to their edge.
   * Ties after that go by name, then id, compared as plain text so every
   * device ranks alike. `autoMatch` false: the form offers it among the
   * nearby ones but never fills it in by itself (a weekly market). An
   * archived location (a shop that closed) is never matched. Distances are
   * computed here over all of them: the set of known locations is small.
   */
  async nearestLocations(
    lat: number,
    lon: number,
    radiusMetres: number,
    limit: number,
  ): Promise<{ tag: Tag; metres: number; autoMatch: boolean }[]> {
    const rows = await this.db.exec<
      TagRow & { latitude: number; longitude: number; radius_metres: number; auto_match: number }
    >(
      `SELECT t.*, d.latitude AS latitude, d.longitude AS longitude, d.radius_metres AS radius_metres,
              d.auto_match AS auto_match
       FROM tags t JOIN location_details d ON d.tag_id = t.id
       WHERE t.kind = 'location' AND t.deleted_at_utc IS NULL AND t.archived_at_utc IS NULL
         AND d.deleted_at_utc IS NULL AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL`,
    )
    const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    return rows
      .map((row) => {
        const centre = haversineMetres(lat, lon, row.latitude, row.longitude)
        return {
          tag: rowToTag(row),
          metres: Math.max(0, centre - row.radius_metres),
          autoMatch: booleanFromColumn(row.auto_match),
          inside: centre <= row.radius_metres,
          centre,
          radius: row.radius_metres,
        }
      })
      .filter((found) => found.metres <= radiusMetres)
      .sort(
        (a, b) =>
          Number(b.inside) - Number(a.inside) ||
          (a.inside ? a.radius - b.radius || a.centre - b.centre : a.metres - b.metres) ||
          text(a.tag.name, b.tag.name) ||
          text(a.tag.id, b.tag.id),
      )
      .slice(0, limit)
      .map(({ tag, metres, autoMatch }) => ({ tag, metres, autoMatch }))
  }
}
