import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { LocationsRepository } from '../LocationsRepository'
import { asUuid } from '../../uuid'

describe('LocationsRepository', () => {
  let db: Database
  let repo: LocationsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new LocationsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates a location with a generated UUID and timestamps', async () => {
    const created = await repo.create({
      name: 'Home',
      description: 'My home',
      address: '123 Main St',
      city: 'Springfield',
      country: 'USA',
      latitude: 40.1234,
      longitude: -74.5678,
      tags: ['personal'],
    })

    expect(created.id).toBeTruthy()
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.name).toBe('Home')
    expect(created.created_at_utc).toBeTruthy()
    expect(created.updated_at_utc).toBeTruthy()
    expect(created.deleted_at_utc).toBeNull()
  })

  it('returns null for a missing location id', async () => {
    expect(await repo.findById(asUuid('nonexistent'))).toBeNull()
  })

  it('returns the location for a present id', async () => {
    const created = await repo.create({
      name: 'Work',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: [],
    })

    const found = await repo.findById(created.id)
    expect(found).not.toBeNull()
    expect(found?.name).toBe('Work')
    expect(found?.id).toBe(created.id)
  })

  it('tags JSON array round-trips through create and findById', async () => {
    const created = await repo.create({
      name: 'Gym',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: ['exercise', 'outdoor'],
    })

    const found = await repo.findById(created.id)
    expect(found?.tags).toEqual(['exercise', 'outdoor'])
  })

  it('latitude and longitude round-trip as numbers (REAL), not strings', async () => {
    const created = await repo.create({
      name: 'Beach',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: 40.7128,
      longitude: -74.006,
      tags: [],
    })

    const found = await repo.findById(created.id)
    expect(found?.latitude).toBe(40.7128)
    expect(found?.longitude).toBe(-74.006)
    expect(typeof found?.latitude).toBe('number')
    expect(typeof found?.longitude).toBe('number')
  })

  it('update patches only provided fields and bumps updated_at_utc', async () => {
    const created = await repo.create({
      name: 'Original',
      description: 'Original description',
      address: '456 Oak Ave',
      city: 'Boston',
      country: 'USA',
      latitude: 42.3601,
      longitude: -71.0589,
      tags: ['tag1'],
    })

    const before = (await repo.findById(created.id))!
    await new Promise((r) => setTimeout(r, 5))
    await repo.update(created.id, { city: 'Cambridge' })
    const after = (await repo.findById(created.id))!

    expect(after.city).toBe('Cambridge')
    expect(after.name).toBe('Original')
    expect(after.description).toBe('Original description')
    expect(after.updated_at_utc > before.updated_at_utc).toBe(true)
  })

  it('softDelete excludes from findById and list', async () => {
    const created = await repo.create({
      name: 'Temporary',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: [],
    })

    await repo.softDelete(created.id)
    expect(await repo.findById(created.id)).toBeNull()
    const list = await repo.list()
    expect(list).toHaveLength(0)
  })

  it('list returns only non-deleted, sorted by name', async () => {
    await repo.create({
      name: 'Zebra',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: [],
    })

    await repo.create({
      name: 'Apple',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: [],
    })

    const created3 = await repo.create({
      name: 'Banana',
      description: null,
      address: null,
      city: null,
      country: null,
      latitude: null,
      longitude: null,
      tags: [],
    })

    await repo.softDelete(created3.id)

    const list = await repo.list()
    expect(list).toHaveLength(2)
    expect(list.map((l) => l.name)).toEqual(['Apple', 'Zebra'])
  })
})
