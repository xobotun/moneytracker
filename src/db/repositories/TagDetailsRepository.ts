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
import { TagKindMismatchError } from '../errors'
import {
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
}

type MerchantDetailsRow = {
  tag_id: string
  default_category_id: string | null
}

type JourneyDetailsRow = {
  tag_id: string
  start_date: string | null
  end_date: string | null
}

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
  if (!tag) throw new Error(`${role}: tag ${id} not found`)
  if (tag.kind !== expected) {
    throw new TagKindMismatchError(
      `${role}: expected a ${expected}, but "${tag.name}" is a ${tag.kind}`,
    )
  }
}

async function readLocation(ex: SqlExecutor, id: ShortId): Promise<LocationDetails | null> {
  const rows = await ex.exec<LocationDetailsRow>(
    `SELECT tag_id, address, latitude, longitude, merchant_id FROM location_details
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
  }
}

async function readMerchant(ex: SqlExecutor, id: ShortId): Promise<MerchantDetails | null> {
  const rows = await ex.exec<MerchantDetailsRow>(
    `SELECT tag_id, default_category_id FROM merchant_details
     WHERE tag_id = ? AND deleted_at_utc IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return {
    tag_id: shortIdFromColumn(row.tag_id),
    default_category_id: shortIdFromNullableColumn(row.default_category_id),
  }
}

async function readJourney(ex: SqlExecutor, id: ShortId): Promise<JourneyDetails | null> {
  const rows = await ex.exec<JourneyDetailsRow>(
    `SELECT tag_id, start_date, end_date FROM journey_details
     WHERE tag_id = ? AND deleted_at_utc IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return {
    tag_id: shortIdFromColumn(row.tag_id),
    start_date: row.start_date,
    end_date: row.end_date,
  }
}

/** The detail fields each kind of tag has; the other kinds have none. */
export const DETAIL_FIELDS_BY_KIND: Record<TagKind, readonly TagDetailField[]> = {
  location: ['address', 'position', 'merchant_id'],
  merchant: ['default_category_id'],
  journey: ['start_date', 'end_date'],
  category: [],
  tag: [],
}

/** A tag's live details as one value set; a missing row means every field is null. */
export async function readDetailValues(
  ex: SqlExecutor,
  id: ShortId,
  kind: TagKind,
): Promise<TagDetailValues> {
  const values: TagDetailValues = {
    address: null,
    position: null,
    merchant_id: null,
    default_category_id: null,
    start_date: null,
    end_date: null,
  }
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
  } else if (kind === 'merchant') {
    values.default_category_id = (await readMerchant(ex, id))?.default_category_id ?? null
  } else if (kind === 'journey') {
    const d = await readJourney(ex, id)
    values.start_date = d?.start_date ?? null
    values.end_date = d?.end_date ?? null
  }
  return values
}

/**
 * Checks that the links in `values` that the kind uses are live tags of the
 * right kind (a location's merchant, a merchant's default category).
 */
export async function assertDetailLinks(
  ex: SqlExecutor,
  kind: TagKind,
  values: Pick<TagDetailValues, 'merchant_id' | 'default_category_id'>,
): Promise<void> {
  if (kind === 'location' && values.merchant_id !== null) {
    await assertLiveKind(ex, values.merchant_id, 'merchant', 'A location’s merchant')
  }
  if (kind === 'merchant' && values.default_category_id !== null) {
    await assertLiveKind(
      ex,
      values.default_category_id,
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
  const rows = await ex.exec<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tags WHERE id = ? AND deleted_at_utc IS NULL',
    [id],
  )
  if (rows[0]!.n === 0) throw new Error(`${role}: tag ${id} was deleted`)
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
    await ex.run(
      `INSERT INTO location_details (tag_id, address, latitude, longitude, merchant_id,
                                     created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         address = excluded.address, latitude = excluded.latitude,
         longitude = excluded.longitude, merchant_id = excluded.merchant_id,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [
        id,
        optionalTextToColumn(v.address),
        v.position?.latitude ?? null,
        v.position?.longitude ?? null,
        v.merchant_id,
        now,
        now,
      ],
    )
  } else if (kind === 'merchant') {
    await ex.run(
      `INSERT INTO merchant_details (tag_id, default_category_id, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         default_category_id = excluded.default_category_id,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [id, v.default_category_id, now, now],
    )
  } else if (kind === 'journey') {
    await ex.run(
      `INSERT INTO journey_details (tag_id, start_date, end_date, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tag_id) DO UPDATE SET
         start_date = excluded.start_date, end_date = excluded.end_date,
         updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
      [id, optionalTextToColumn(v.start_date), optionalTextToColumn(v.end_date), now, now],
    )
  }
}

/**
 * What only one kind of tag has, in a side table keyed by the tag's id: a
 * location's address, coordinates and merchant; a merchant's default
 * category; a journey's typed dates. Each kind is checked on write.
 */
export class TagDetailsRepository {
  constructor(private db: Database) {}

  getLocation(id: ShortId): Promise<LocationDetails | null> {
    return readLocation(this.db, id)
  }

  /** Stores the details of a location tag; `merchant_id` must be a merchant. */
  async setLocation(id: ShortId, d: Omit<LocationDetails, 'tag_id'>): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await assertKind(tx, id, 'location', 'Location details')
      if (d.merchant_id !== null)
        await assertKind(tx, d.merchant_id, 'merchant', 'A location’s merchant')
      await tx.run(
        `INSERT INTO location_details (tag_id, address, latitude, longitude, merchant_id,
                                       created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tag_id) DO UPDATE SET
           address = excluded.address, latitude = excluded.latitude,
           longitude = excluded.longitude, merchant_id = excluded.merchant_id,
           updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
        [id, optionalTextToColumn(d.address), d.latitude, d.longitude, d.merchant_id, now, now],
      )
    })
  }

  getMerchant(id: ShortId): Promise<MerchantDetails | null> {
    return readMerchant(this.db, id)
  }

  /** Stores the details of a merchant tag; `default_category_id` must be a category. */
  async setMerchant(id: ShortId, d: Omit<MerchantDetails, 'tag_id'>): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await assertKind(tx, id, 'merchant', 'Merchant details')
      if (d.default_category_id !== null) {
        await assertKind(tx, d.default_category_id, 'category', 'A merchant’s default category')
      }
      await tx.run(
        `INSERT INTO merchant_details (tag_id, default_category_id, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tag_id) DO UPDATE SET
           default_category_id = excluded.default_category_id,
           updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
        [id, d.default_category_id, now, now],
      )
    })
  }

  getJourney(id: ShortId): Promise<JourneyDetails | null> {
    return readJourney(this.db, id)
  }

  /** Stores the dates typed for a journey tag (null = derived from its transactions). */
  async setJourney(id: ShortId, d: Omit<JourneyDetails, 'tag_id'>): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.transaction(async (tx) => {
      await assertKind(tx, id, 'journey', 'Journey details')
      await tx.run(
        `INSERT INTO journey_details (tag_id, start_date, end_date, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tag_id) DO UPDATE SET
           start_date = excluded.start_date, end_date = excluded.end_date,
           updated_at_utc = excluded.updated_at_utc, deleted_at_utc = NULL`,
        [id, optionalTextToColumn(d.start_date), optionalTextToColumn(d.end_date), now, now],
      )
    })
  }

  /**
   * A journey's start and end dates ('YYYY-MM-DD'): each the date the user
   * typed (`*Typed`), else derived — the first and the last of the local
   * calendar dates of the journey's live transactions (by their date
   * override when they have one) and of its live journeys below it, including
   * the dates typed on those, so a parent covers its children (decisions
   * §2.7). A deleted journey and everything under it no longer count. Null
   * when there is nothing to derive from.
   */
  async journeyDates(id: ShortId): Promise<{
    start: string | null
    end: string | null
    startTyped: boolean
    endTyped: boolean
  }> {
    const typed = await this.getJourney(id)
    // Each transaction counts by its own local date, so the range contains
    // every one of them even when their offsets differ ('YYYY-MM-DD' text
    // sorts as dates; the full offset-bearing moments would not).
    const rows = await this.db.exec<{ first_date: string | null; last_date: string | null }>(
      `WITH RECURSIVE journey(id) AS (
         SELECT ?
         UNION
         SELECT t.id FROM tags t JOIN journey j ON t.parent_id = j.id
         WHERE t.deleted_at_utc IS NULL
       ),
       dates(d) AS (
         SELECT substr(COALESCE(date_override_local, transaction_at_local), 1, 10)
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
    const derived = rows[0]!
    const start = typed?.start_date ?? null
    const end = typed?.end_date ?? null
    return {
      start: start ?? derived.first_date,
      end: end ?? derived.last_date,
      startTyped: start !== null,
      endTyped: end !== null,
    }
  }

  /**
   * Live locations with coordinates within `radiusMetres` of the point,
   * nearest first, at most `limit`. Distances are computed here over all of
   * them: the set of known locations is small.
   */
  async nearestLocations(
    lat: number,
    lon: number,
    radiusMetres: number,
    limit: number,
  ): Promise<{ tag: Tag; metres: number }[]> {
    const rows = await this.db.exec<TagRow & { latitude: number; longitude: number }>(
      `SELECT t.*, d.latitude AS latitude, d.longitude AS longitude
       FROM tags t JOIN location_details d ON d.tag_id = t.id
       WHERE t.kind = 'location' AND t.deleted_at_utc IS NULL AND d.deleted_at_utc IS NULL
         AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL`,
    )
    return rows
      .map((row) => ({
        tag: rowToTag(row),
        metres: haversineMetres(lat, lon, row.latitude, row.longitude),
      }))
      .filter((found) => found.metres <= radiusMetres)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, limit)
  }
}
