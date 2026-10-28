import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import {
  DeletedTagError,
  InvalidTagDetailsError,
  TagKindMismatchError,
  TagNotFoundError,
} from '../../errors'
import { TagsRepository } from '../TagsRepository'
import { TagDetailsRepository, noDetails } from '../TagDetailsRepository'
import type { TagDetailValues } from '../../types'
import { newId } from '../../uuid'
import { asShortId, type ShortId } from '../../shortId'

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
      radius_metres: 10,
      auto_match: true,
    })
    expect(await repo.getMerchant(rewe.id)).toEqual({
      tag_id: rewe.id,
      default_category_id: groceries.id,
      auto_match: true,
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
      radius_metres: 10,
      auto_match: true,
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
    await expect(
      repo.setMerchant(asShortId('nowhere00000'), { default_category_id: null }),
    ).rejects.toThrow(TagNotFoundError)
  })

  it('refuses a newly linked deleted tag but keeps one already linked', async () => {
    const groceries = await tags.create({ kind: 'category', name: 'Groceries' })
    const drinks = await tags.create({ kind: 'category', name: 'Drinks' })
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    const lidl = await tags.create({ kind: 'merchant', name: 'Lidl' })
    const store = await tags.create({ kind: 'location', name: 'Rewe Alexanderplatz' })
    const place = { address: null, latitude: null, longitude: null }
    await repo.setMerchant(rewe.id, { default_category_id: groceries.id })
    await repo.setLocation(store.id, { ...place, merchant_id: rewe.id })
    await tags.softDelete(groceries.id)
    await tags.softDelete(drinks.id)
    await tags.softDelete(rewe.id)

    // Saving other details keeps the links the tags already have.
    await repo.setMerchant(rewe.id, { default_category_id: groceries.id })
    await repo.setLocation(store.id, {
      ...place,
      address: 'Alexanderplatz 1',
      merchant_id: rewe.id,
    })
    expect(await repo.getLocation(store.id)).toMatchObject({
      address: 'Alexanderplatz 1',
      merchant_id: rewe.id,
    })

    // Nothing new can link to a deleted tag.
    await expect(repo.setMerchant(lidl.id, { default_category_id: groceries.id })).rejects.toThrow(
      DeletedTagError,
    )
    await expect(repo.setMerchant(rewe.id, { default_category_id: drinks.id })).rejects.toThrow(
      DeletedTagError,
    )
    const other = await tags.create({ kind: 'location', name: 'Lidl Mitte' })
    await expect(repo.setLocation(other.id, { ...place, merchant_id: rewe.id })).rejects.toThrow(
      DeletedTagError,
    )
    expect(await repo.getMerchant(lidl.id)).toBeNull()
    expect(await repo.getLocation(other.id)).toBeNull()
  })

  it('refuses a lone coordinate', async () => {
    const store = await tags.create({ kind: 'location', name: 'Rewe Alexanderplatz' })
    for (const [latitude, longitude] of [
      [52.5, null],
      [null, 13.4],
    ] as const) {
      await expect(
        repo.setLocation(store.id, { address: null, latitude, longitude, merchant_id: null }),
      ).rejects.toThrow(InvalidTagDetailsError)
    }
    expect(await repo.getLocation(store.id)).toBeNull()
  })

  it('accepts journey dates that are calendar dates, the start not after the end', async () => {
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon' })
    for (const [start_date, end_date] of [
      ['2026-7-1', null],
      [null, '2026-02-30'],
      ['01.07.2026', null],
      ['', null],
      ['2026-07-10', '2026-07-01'],
    ] as const) {
      await expect(repo.setJourney(lisbon.id, { start_date, end_date })).rejects.toThrow(
        InvalidTagDetailsError,
      )
    }
    expect(await repo.getJourney(lisbon.id)).toBeNull()

    await repo.setJourney(lisbon.id, { start_date: '2026-07-01', end_date: '2026-07-01' })
    await repo.setJourney(lisbon.id, { start_date: null, end_date: '2024-02-29' })
    expect(await repo.getJourney(lisbon.id)).toMatchObject({
      start_date: null,
      end_date: '2024-02-29',
    })
  })

  it('finds nearest locations within the radius, nearest first, live only', async () => {
    // Distances count to the edge of each location's circle (10 m by default).
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
    expect(found[0]!.metres).toBeCloseTo(40, 0)
    expect(found[1]!.metres).toBeCloseTo(130, 0)
    expect(found[0]!.tag.name).toBe('Near')
    expect((await repo.nearestLocations(BASE.lat, BASE.lon, 150, 1)).map((f) => f.tag.id)).toEqual([
      near.id,
    ])
    expect((await repo.nearestLocations(BASE.lat, BASE.lon, 500, 10)).map((f) => f.tag.id)).toEqual(
      [near.id, middle.id, far.id],
    )
  })

  /**
   * A raw transaction on journey `journeyId`, in Lisbon time unless the moment
   * says otherwise (raw SQL: the rules of TransactionsRepository are not under test).
   */
  async function spendOn(
    journeyId: ShortId | null,
    local: string,
    opts: { override?: string; deleted?: boolean } = {},
  ) {
    const now = '2026-10-26T10:00:00.000Z'
    await db.run(
      `INSERT INTO transactions (id,
         amount_value__from, amount_scale__from, amount_currency__from,
         amount_value__to, amount_scale__to, amount_currency__to,
         transaction_at_local, transaction_at_zone, date_override_local, date_override_zone,
         journey_id, created_at_utc, updated_at_utc, deleted_at_utc)
       VALUES (?, 100, 2, 'EUR', 100, 2, 'EUR', ?, 'Europe/Lisbon', ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        local,
        opts.override ?? null,
        opts.override === undefined ? null : 'Europe/Lisbon',
        journeyId,
        now,
        now,
        opts.deleted ? now : null,
      ],
    )
  }

  const derived = (start: string | null, end: string | null) => ({
    start,
    end,
    startTyped: false,
    endTyped: false,
    derivedStart: start,
    derivedEnd: end,
  })

  it('journeyDates derives from the earliest and latest transaction of the journey and its children', async () => {
    const summer = await tags.create({ kind: 'journey', name: 'Summer 2026' })
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon', parent_id: summer.id })
    const sintra = await tags.create({ kind: 'journey', name: 'Sintra', parent_id: lisbon.id })
    const porto = await tags.create({ kind: 'journey', name: 'Porto', parent_id: summer.id })
    const winter = await tags.create({ kind: 'journey', name: 'Winter' })

    await spendOn(summer.id, '2026-07-05T12:00:00.000+01:00')
    await spendOn(lisbon.id, '2026-07-03T12:00:00.000+01:00')
    await spendOn(sintra.id, '2026-07-01T09:30:00.000+01:00') // a grandchild of Summer: the earliest
    await spendOn(porto.id, '2026-07-14T23:30:00.000+01:00') // the latest
    // Paid on the 20th, booked to the 12th: the override is what counts.
    await spendOn(porto.id, '2026-07-20T12:00:00.000+01:00', {
      override: '2026-07-12T12:00:00.000+01:00',
    })
    await spendOn(lisbon.id, '2026-06-20T12:00:00.000+01:00', { deleted: true })
    await spendOn(winter.id, '2026-12-01T12:00:00.000+00:00')
    await spendOn(null, '2026-08-01T12:00:00.000+01:00')

    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-07-01', '2026-07-14'))
    expect(await repo.journeyDates(lisbon.id)).toEqual(derived('2026-07-01', '2026-07-03'))
    expect(await repo.journeyDates(porto.id)).toEqual(derived('2026-07-12', '2026-07-14'))

    const someday = await tags.create({ kind: 'journey', name: 'Someday' })
    expect(await repo.journeyDates(someday.id)).toEqual(derived(null, null))
  })

  it('journeyDates prefers stored dates', async () => {
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon' })
    await spendOn(lisbon.id, '2026-07-01T09:30:00.000+01:00')
    await spendOn(lisbon.id, '2026-07-10T18:00:00.000+01:00')

    // Landed after midnight, with nothing bought that day.
    await repo.setJourney(lisbon.id, { start_date: '2026-06-30', end_date: null })
    expect(await repo.journeyDates(lisbon.id)).toEqual({
      start: '2026-06-30',
      end: '2026-07-10',
      startTyped: true,
      endTyped: false,
      derivedStart: '2026-07-01',
      derivedEnd: '2026-07-10',
    })

    await repo.setJourney(lisbon.id, { start_date: null, end_date: '2026-07-11' })
    expect(await repo.journeyDates(lisbon.id)).toEqual({
      start: '2026-07-01',
      end: '2026-07-11',
      startTyped: false,
      endTyped: true,
      derivedStart: '2026-07-01',
      derivedEnd: '2026-07-10',
    })

    await repo.setJourney(lisbon.id, { start_date: '2026-06-30', end_date: '2026-07-11' })
    expect(await repo.journeyDates(lisbon.id)).toEqual({
      start: '2026-06-30',
      end: '2026-07-11',
      startTyped: true,
      endTyped: true,
      derivedStart: '2026-07-01',
      derivedEnd: '2026-07-10',
    })

    // A deleted details row holds no dates.
    await db.run('UPDATE journey_details SET deleted_at_utc = ?', ['2026-10-26T11:00:00.000Z'])
    expect(await repo.journeyDates(lisbon.id)).toEqual({
      start: '2026-07-01',
      end: '2026-07-10',
      startTyped: false,
      endTyped: false,
      derivedStart: '2026-07-01',
      derivedEnd: '2026-07-10',
    })
  })

  it("journeyDates of a parent covers its children's typed dates", async () => {
    const summer = await tags.create({ kind: 'journey', name: 'Summer 2026' })
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon', parent_id: summer.id })
    const porto = await tags.create({ kind: 'journey', name: 'Porto', parent_id: summer.id })
    const douro = await tags.create({ kind: 'journey', name: 'Douro', parent_id: porto.id })
    await spendOn(lisbon.id, '2026-07-03T12:00:00.000+01:00')
    await spendOn(porto.id, '2026-07-10T12:00:00.000+01:00')
    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-07-03', '2026-07-10'))

    // Landed in Lisbon after midnight, before any purchase; a grandchild ends after the last one.
    await repo.setJourney(lisbon.id, { start_date: '2026-06-30', end_date: null })
    await repo.setJourney(douro.id, { start_date: null, end_date: '2026-07-20' })

    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-06-30', '2026-07-20'))
    expect(await repo.journeyDates(porto.id)).toEqual(derived('2026-07-10', '2026-07-20'))
    // Its own typed date is not part of a journey's derived other end.
    expect(await repo.journeyDates(lisbon.id)).toEqual({
      start: '2026-06-30',
      end: '2026-07-03',
      startTyped: true,
      endTyped: false,
      derivedStart: '2026-07-03',
      derivedEnd: '2026-07-03',
    })

    // A deleted details row types nothing.
    await db.run('UPDATE journey_details SET deleted_at_utc = ? WHERE tag_id = ?', [
      '2026-10-26T11:00:00.000Z',
      douro.id,
    ])
    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-06-30', '2026-07-10'))
  })

  it('journeyDates leaves out deleted journeys below it', async () => {
    const summer = await tags.create({ kind: 'journey', name: 'Summer 2026' })
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon', parent_id: summer.id })
    const sintra = await tags.create({ kind: 'journey', name: 'Sintra', parent_id: lisbon.id })
    const porto = await tags.create({ kind: 'journey', name: 'Porto', parent_id: summer.id })
    await spendOn(summer.id, '2026-07-05T12:00:00.000+01:00')
    await spendOn(lisbon.id, '2026-06-20T12:00:00.000+01:00')
    await spendOn(sintra.id, '2026-06-25T12:00:00.000+01:00')
    await spendOn(porto.id, '2026-07-28T12:00:00.000+01:00')
    await repo.setJourney(porto.id, { start_date: null, end_date: '2026-07-30' })
    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-06-20', '2026-07-30'))

    // Neither Porto's transactions nor its typed end count once it is deleted.
    await tags.softDelete(porto.id)
    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-06-20', '2026-07-05'))

    // A sync can bring a deletion whose children were not moved up: the walk stops there.
    await db.run('UPDATE tags SET deleted_at_utc = ? WHERE id = ?', [
      '2026-10-26T11:00:00.000Z',
      lisbon.id,
    ])
    expect(await repo.journeyDates(summer.id)).toEqual(derived('2026-07-05', '2026-07-05'))
  })

  it('journeyDates spans the local dates of transactions in different offsets', async () => {
    const lisbon = await tags.create({ kind: 'journey', name: 'Lisbon' })
    // 22:10Z and 22:20Z: the earlier moment has the later local date.
    await spendOn(lisbon.id, '2026-07-02T00:10:00.000+02:00')
    await spendOn(lisbon.id, '2026-07-01T23:20:00.000+01:00')
    expect(await repo.journeyDates(lisbon.id)).toEqual(derived('2026-07-01', '2026-07-02'))
  })

  it("detailsByTag reads every live details row, each kind's fields", async () => {
    const food = await tags.create({ kind: 'category', name: 'Food' })
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    const edeka = await tags.create({ kind: 'merchant', name: 'Edeka' })
    const mitte = await tags.create({ kind: 'location', name: 'Rewe Mitte' })
    const home = await tags.create({ kind: 'location', name: 'Home' })
    await repo.setMerchant(rewe.id, { default_category_id: food.id })
    await repo.setMerchant(edeka.id, { default_category_id: null })
    await repo.setLocation(mitte.id, {
      address: null,
      latitude: null,
      longitude: null,
      merchant_id: rewe.id,
    })
    await repo.setLocation(home.id, {
      address: 'Weg 1',
      latitude: null,
      longitude: null,
      merchant_id: null,
    })
    const rome = await tags.create({ kind: 'journey', name: 'Rome' })
    await repo.setJourney(rome.id, { start_date: '2026-05-01', end_date: null })
    // A deleted details row links nothing.
    const gone = await tags.create({ kind: 'location', name: 'Gone' })
    await repo.setLocation(gone.id, {
      address: null,
      latitude: null,
      longitude: null,
      merchant_id: rewe.id,
    })
    await db.run('UPDATE location_details SET deleted_at_utc = ? WHERE tag_id = ?', [
      '2026-10-26T11:00:00.000Z',
      gone.id,
    ])

    const none = noDetails()
    const place = { radius_metres: 10, auto_match: true }
    expect(await repo.detailsByTag()).toEqual(
      new Map<ShortId, TagDetailValues>([
        [mitte.id, { ...none, ...place, merchant_id: rewe.id }],
        [home.id, { ...none, ...place, address: 'Weg 1' }],
        [rewe.id, { ...none, default_category_id: food.id, auto_match: true }],
        [edeka.id, { ...none, auto_match: true }],
        [rome.id, { ...none, start_date: '2026-05-01' }],
      ]),
    )
  })

  it("stores a location's radius, 10 m by default", async () => {
    const shop = await tags.create({ kind: 'location', name: 'Shop' })
    const at = { address: null, latitude: 52.5, longitude: 13.4, merchant_id: null }
    await repo.setLocation(shop.id, at)
    expect((await repo.getLocation(shop.id))!.radius_metres).toBe(10)
    expect((await repo.values(shop.id, 'location')).radius_metres).toBe(10)
    await repo.setLocation(shop.id, { ...at, radius_metres: 80 })
    expect((await repo.getLocation(shop.id))!.radius_metres).toBe(80)

    for (const bad of [0, -5, 2.5]) {
      await expect(repo.setLocation(shop.id, { ...at, radius_metres: bad })).rejects.toThrow(
        InvalidTagDetailsError,
      )
    }
    // A location without a details row has the default too; other kinds have none.
    const other = await tags.create({ kind: 'location', name: 'Other' })
    expect((await repo.values(other.id, 'location')).radius_metres).toBe(10)
    const food = await tags.create({ kind: 'category', name: 'Food' })
    expect((await repo.values(food.id, 'category')).radius_metres).toBeNull()
  })

  it('measures from the edge of a big location', async () => {
    const mall = await tags.create({ kind: 'location', name: 'Mall' })
    await repo.setLocation(mall.id, {
      address: null,
      latitude: north(180),
      longitude: BASE.lon,
      merchant_id: null,
      radius_metres: 100,
    })
    const [found] = await repo.nearestLocations(BASE.lat, BASE.lon, 150, 10)
    expect(found!.tag.id).toBe(mall.id)
    expect(found!.metres).toBeCloseTo(80, 0)
    // Inside the circle is no distance at all.
    const [inside] = await repo.nearestLocations(north(150), BASE.lon, 150, 10)
    expect(inside!.metres).toBe(0)
  })

  it('stores whether a location matches transactions automatically, on by default', async () => {
    const market = await tags.create({ kind: 'location', name: 'Market' })
    const at = { address: null, latitude: north(20), longitude: BASE.lon, merchant_id: null }
    await repo.setLocation(market.id, at)
    expect((await repo.getLocation(market.id))!.auto_match).toBe(true)
    expect((await repo.values(market.id, 'location')).auto_match).toBe(true)
    await repo.setLocation(market.id, { ...at, auto_match: false })
    expect((await repo.getLocation(market.id))!.auto_match).toBe(false)
    expect((await repo.values(market.id, 'location')).auto_match).toBe(false)

    // Still found nearby, flagged, so the form can offer it but not fill it in.
    const [found] = await repo.nearestLocations(BASE.lat, BASE.lon, 150, 10)
    expect(found).toMatchObject({ autoMatch: false })
    const food = await tags.create({ kind: 'category', name: 'Food' })
    expect((await repo.values(food.id, 'category')).auto_match).toBeNull()
  })

  it('stores whether a merchant matches imported lines automatically, on by default', async () => {
    const rewe = await tags.create({ kind: 'merchant', name: 'Rewe' })
    await repo.setMerchant(rewe.id, { default_category_id: null })
    expect((await repo.getMerchant(rewe.id))!.auto_match).toBe(true)
    await repo.setMerchant(rewe.id, { default_category_id: null, auto_match: false })
    expect((await repo.getMerchant(rewe.id))!.auto_match).toBe(false)
    expect((await repo.values(rewe.id, 'merchant')).auto_match).toBe(false)
    expect((await repo.detailsByTag()).get(rewe.id)!.auto_match).toBe(false)
    // A merchant without a details row matches too.
    const edeka = await tags.create({ kind: 'merchant', name: 'Edeka' })
    expect((await repo.values(edeka.id, 'merchant')).auto_match).toBe(true)
  })
})
