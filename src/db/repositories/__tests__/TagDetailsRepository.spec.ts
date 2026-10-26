import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { TagKindMismatchError } from '../../errors'
import { TagsRepository } from '../TagsRepository'
import { TagDetailsRepository } from '../TagDetailsRepository'

// Metres per degree of latitude on the mean Earth radius (6 371 008.8 m).
const METRES_PER_DEGREE = (Math.PI / 180) * 6_371_008.8
const BASE = { lat: 52.52, lon: 13.405 }
const north = (metres: number) => BASE.lat + metres / METRES_PER_DEGREE

describe('TagDetailsRepository', () => {
  let db: Database
  let tags: TagsRepository
  let repo: TagDetailsRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    tags = new TagsRepository(db)
    repo = new TagDetailsRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  it('stores and reads back the details of each kind', async () => {
    const groceries = await tags.create({ kind: 'category', name: 'Groceries' })
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    const store = await tags.create({ kind: 'location', name: 'Rewe Alexanderplatz' })
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon' })

    expect(await repo.getLocation(store.id)).toBeNull()

    await repo.setLocation(store.id, {
      address: 'Alexanderplatz 1',
      latitude: 52.5219,
      longitude: 13.4132,
      merchant_id: rewe.id,
    })
    await repo.setMerchant(rewe.id, { default_category_id: groceries.id })
    await repo.setJourney(lisbon.id, { start_date: '2026-07-01', end_date: null })

    expect(await repo.getLocation(store.id)).toEqual({
      tag_id: store.id,
      address: 'Alexanderplatz 1',
      latitude: 52.5219,
      longitude: 13.4132,
      merchant_id: rewe.id,
    })
    expect(await repo.getMerchant(rewe.id)).toEqual({
      tag_id: rewe.id,
      default_category_id: groceries.id,
    })
    expect(await repo.getJourney(lisbon.id)).toEqual({
      tag_id: lisbon.id,
      start_date: '2026-07-01',
      end_date: null,
    })

    // Setting again replaces the row in place; an empty address is NULL.
    await repo.setLocation(store.id, {
      address: '',
      latitude: null,
      longitude: null,
      merchant_id: null,
    })
    expect(await repo.getLocation(store.id)).toEqual({
      tag_id: store.id,
      address: null,
      latitude: null,
      longitude: null,
      merchant_id: null,
    })
    expect(await db.exec('SELECT tag_id FROM location_details')).toHaveLength(1)
  })

  it('refuses location details on a merchant', async () => {
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    await expect(
      repo.setLocation(rewe.id, { address: null, latitude: 1, longitude: 2, merchant_id: null }),
    ).rejects.toThrow(TagKindMismatchError)
    expect(await repo.getLocation(rewe.id)).toBeNull()
  })

  it('refuses a location’s merchant that is not a merchant', async () => {
    const store = await tags.create({ kind: 'location', name: 'Rewe Alexanderplatz' })
    const groceries = await tags.create({ kind: 'category', name: 'Groceries' })
    await expect(
      repo.setLocation(store.id, {
        address: null,
        latitude: null,
        longitude: null,
        merchant_id: groceries.id,
      }),
    ).rejects.toThrow(TagKindMismatchError)
  })

  it('checks the kinds of merchant and journey details', async () => {
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    const lidl = await tags.create({ kind: 'merchant', name: 'Lidl' })
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon' })

    await expect(repo.setMerchant(rewe.id, { default_category_id: lidl.id })).rejects.toThrow(
      TagKindMismatchError,
    )
    await expect(repo.setMerchant(lisbon.id, { default_category_id: null })).rejects.toThrow(
      TagKindMismatchError,
    )
    await expect(repo.setJourney(rewe.id, { start_date: null, end_date: null })).rejects.toThrow(
      TagKindMismatchError,
    )
  })

  it('finds nearest locations within the radius, nearest first, live only', async () => {
    async function place(name: string, metresNorth: number | null) {
      const tag = await tags.create({ kind: 'location', name })
      await repo.setLocation(tag.id, {
        address: null,
        latitude: metresNorth === null ? null : north(metresNorth),
        longitude: metresNorth === null ? null : BASE.lon,
        merchant_id: null,
      })
      return tag
    }
    const far = await place('Far', 400)
    const near = await place('Near', 50)
    const middle = await place('Middle', 140)
    const deleted = await place('Deleted', 30)
    await place('Unplaced', null)
    await tags.softDelete(deleted.id)

    const found = await repo.nearestLocations(BASE.lat, BASE.lon, 150, 10)

    expect(found.map((f) => f.tag.id)).toEqual([near.id, middle.id])
    expect(found[0]!.metres).toBeCloseTo(50, 0)
    expect(found[1]!.metres).toBeCloseTo(140, 0)
    expect(found[0]!.tag.name).toBe('Near')
    expect((await repo.nearestLocations(BASE.lat, BASE.lon, 150, 1)).map((f) => f.tag.id)).toEqual([
      near.id,
    ])
    expect((await repo.nearestLocations(BASE.lat, BASE.lon, 500, 10)).map((f) => f.tag.id)).toEqual(
      [near.id, middle.id, far.id],
    )
  })
})
