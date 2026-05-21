import type { Database } from '../Database'
import type { Location } from '../types'
import { newId, type UUID } from '../uuid'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonArrayFromColumn,
  jsonArrayToColumn,
  uuidFromColumn,
} from '../columnMappers'

type LocationRow = {
  id: string
  name: string
  description: string | null
  address: string | null
  city: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  tags: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type LocationCreateInput = Omit<Location, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>

type LocationUpdateInput = Partial<
  Omit<Location, 'id' | 'created_at_utc' | 'updated_at_utc' | 'deleted_at_utc'>
>

function rowToLocation(row: LocationRow): Location {
  return {
    id: uuidFromColumn(row.id),
    name: row.name,
    description: row.description,
    address: row.address,
    city: row.city,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    tags: jsonArrayFromColumn<string>(row.tags),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

export class LocationsRepository {
  constructor(private db: Database) {}

  async create(input: LocationCreateInput): Promise<Location> {
    const id = newId()
    const now = instantToColumn(new Date())
    await this.db.run(
      `INSERT INTO locations (id, name, description, address, city, country, latitude, longitude, tags, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? null,
        input.address ?? null,
        input.city ?? null,
        input.country ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        jsonArrayToColumn(input.tags),
        now,
        now,
      ],
    )
    return (await this.findById(id))!
  }

  async findById(id: UUID): Promise<Location | null> {
    const rows = await this.db.exec<LocationRow>(
      'SELECT * FROM locations WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToLocation(rows[0]!)
  }

  async list(): Promise<Location[]> {
    const rows = await this.db.exec<LocationRow>(
      'SELECT * FROM locations WHERE deleted_at_utc IS NULL ORDER BY name',
    )
    return rows.map(rowToLocation)
  }

  async update(id: UUID, patch: LocationUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (patch.address !== undefined) { sets.push('address = ?'); params.push(patch.address) }
    if (patch.city !== undefined) { sets.push('city = ?'); params.push(patch.city) }
    if (patch.country !== undefined) { sets.push('country = ?'); params.push(patch.country) }
    if (patch.latitude !== undefined) { sets.push('latitude = ?'); params.push(patch.latitude) }
    if (patch.longitude !== undefined) { sets.push('longitude = ?'); params.push(patch.longitude) }
    if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(jsonArrayToColumn(patch.tags)) }

    if (sets.length === 0) return

    sets.push('updated_at_utc = ?')
    params.push(instantToColumn(new Date()))
    params.push(id)

    await this.db.run(`UPDATE locations SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  async softDelete(id: UUID): Promise<void> {
    const now = instantToColumn(new Date())
    await this.db.run(
      'UPDATE locations SET deleted_at_utc = ?, updated_at_utc = ? WHERE id = ?',
      [now, now, id],
    )
  }
}
