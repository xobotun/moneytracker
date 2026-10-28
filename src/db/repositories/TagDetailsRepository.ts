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
}

type JourneyDetailsRow = {
  tag_id: string
  start_date: string | null
  end_date: string | null
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
  location: ['address', 'position', 'merchant_id', 'radius_metres', 'auto_match'],
  merchant: ['default_category_id'],
  journey: ['start_date', 'end_date'],
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
    values.default_category_id = (await readMerchant(ex, id))?.default_category_id ?? null
  } else if (kind === 'journey') {
    const d = await readJourney(ex, id)
    values.start_date = d?.start_date ?? null
    values.end_date = d?.end_date ?? null
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

  /** The tag's details as one value set (all empty for a kind without details). */
  values(id: ShortId, kind: TagKind): Promise<TagDetailValues> {
    return readDetailValues(this.db, id, kind)
  }

  /**
   * The tag each merchant and location links to, by its id: a merchant's
   * default category, a location's merchant. Only links that are set, from
   * live details rows; the linked tag may be deleted since.
   */
  async detailLinks(): Promise<Map<ShortId, ShortId>> {
    const rows = await this.db.exec<{ tag_id: string; link: string }>(
      `SELECT tag_id, default_category_id AS link FROM merchant_details
       WHERE deleted_at_utc IS NULL AND default_category_id IS NOT NULL
       UNION ALL
       SELECT tag_id, merchant_id AS link FROM location_details
       WHERE deleted_at_utc IS NULL AND merchant_id IS NOT NULL`,
    )
    return new Map(rows.map((row) => [shortIdFromColumn(row.tag_id), shortIdFromColumn(row.link)]))
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
   * category, live unless the merchant already has it.
   */
  async setMerchant(id: ShortId, d: Omit<MerchantDetails, 'tag_id'>): Promise<void> {
    await this.write(id, 'merchant', 'Merchant details', {
      ...noDetails(),
      default_category_id: d.default_category_id,
    })
  }

  getJourney(id: ShortId): Promise<JourneyDetails | null> {
    return readJourney(this.db, id)
  }

  /**
   * Stores the dates typed for a journey tag (null = derived from its
   * transactions): calendar dates 'YYYY-MM-DD', the start not after the end.
   */
  async setJourney(id: ShortId, d: Omit<JourneyDetails, 'tag_id'>): Promise<void> {
    assertJourneyDates(d)
    await this.write(id, 'journey', 'Journey details', {
      ...noDetails(),
      start_date: d.start_date,
      end_date: d.end_date,
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

  /**
   * A journey's start and end dates ('YYYY-MM-DD'): each the date the user
   * typed (`*Typed`), else derived — the first and the last of the local
   * calendar dates of the journey's live transactions (by their date
   * override when they have one) and of its live journeys below it, including
   * the dates typed on those, so a parent covers its children (decisions
   * §2.7). A deleted journey and everything under it no longer count. Null
   * when there is nothing to derive from. `derivedStart` / `derivedEnd` are
   * the derived ones even where a date is typed: what a reset goes back to.
   */
  async journeyDates(id: ShortId): Promise<{
    start: string | null
    end: string | null
    startTyped: boolean
    endTyped: boolean
    derivedStart: string | null
    derivedEnd: string | null
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
      derivedStart: derived.first_date,
      derivedEnd: derived.last_date,
    }
  }

  /**
   * Live locations with coordinates within `radiusMetres` of the point,
   * nearest first, at most `limit`. A distance counts to the edge of the
   * location's circle (its own radius), 0 inside it, so a big place matches
   * from anywhere in it. `autoMatch` false: the form offers it among the
   * nearby ones but never fills it in by itself (a weekly market). Distances are computed here over all of them: the
   * set of known locations is small.
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
       WHERE t.kind = 'location' AND t.deleted_at_utc IS NULL AND d.deleted_at_utc IS NULL
         AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL`,
    )
    return rows
      .map((row) => ({
        tag: rowToTag(row),
        metres: Math.max(
          0,
          haversineMetres(lat, lon, row.latitude, row.longitude) - row.radius_metres,
        ),
        autoMatch: booleanFromColumn(row.auto_match),
      }))
      .filter((found) => found.metres <= radiusMetres)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, limit)
  }
}
