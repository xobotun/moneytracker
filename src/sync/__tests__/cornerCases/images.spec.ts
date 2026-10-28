import { describe, it, expect, afterEach } from 'vitest'
import { exportAllTables, importAllTables } from '../../csvCodec'
import { hashDatabase } from '../../hashDatabase'
import {
  at,
  expectConverged,
  minute,
  openPair,
  start,
  type BackendKind,
  type Device,
  type World,
} from '../devices'
import { newMigratedDb } from '../helpers'
import { ImagesRepository } from '../../../db/repositories/ImagesRepository'

// Images are synced rows that never change, keyed by their content
// (docs/plans/2026-10-28-icons-design.md §3).

// Markup with what CSV must quote: commas, quotes and a line break.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <text x="2" y="18" font-family="Helvetica, Arial">C&amp;A</text></svg>`
const WEBP = 'UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='

// Something to sync first, so every device starts from the same remote.
const seed = async (device: Device) => {
  await device.tags.create({ kind: 'tag', name: 'home' })
}

describe.each<BackendKind>(['memory', 'github'])('images through the %s backend', (kind) => {
  let world: World

  afterEach(async () => {
    await world.close()
  })

  it('arrive on the other device as they were put', async () => {
    const [a, b] = (world = await openPair(kind)).devices
    await start(world, seed)
    at(minute(1))
    const word = await a.images.put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: null,
      height: null,
      source: { text: 'C&A', font: 'sans', bold: false },
    })
    const logo = await a.images.put({ mediaType: 'image/webp', content: WEBP, width: 2, height: 1 })
    at(minute(2))
    await a.sync()
    at(minute(3))
    await b.sync()

    for (const id of [word, logo]) {
      const { created_at_utc, updated_at_utc, ...arrived } = (await b.images.get(id))!
      const { created_at_utc: c, updated_at_utc: u, ...put } = (await a.images.get(id))!
      expect(arrived).toEqual(put)
      expect([created_at_utc, updated_at_utc]).toEqual([c, u])
    }
    expect(await b.images.get(word)).toMatchObject({ width: null, height: null })
    await expectConverged([a, b], minute(4))
  })

  it('put on two devices at different times are one row, with no conflict', async () => {
    const [a, b] = (world = await openPair(kind)).devices
    await start(world, seed)
    at(minute(1))
    const id = await a.images.put({ mediaType: 'image/webp', content: WEBP, width: 2, height: 1 })
    at(minute(2))
    expect(
      await b.images.put({ mediaType: 'image/webp', content: WEBP, width: 2, height: 1 }),
    ).toBe(id)
    at(minute(3))
    expect((await a.sync()).conflicts).toEqual([])
    at(minute(4))
    expect((await b.sync()).conflicts).toEqual([])
    at(minute(5))
    expect((await a.sync()).conflicts).toEqual([])
    await expectConverged([a, b], minute(6))
  })
})

it('an image survives a CSV round trip', async () => {
  const db = await newMigratedDb()
  const copy = await newMigratedDb()
  try {
    await new ImagesRepository(db).put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: null,
      height: null,
    })
    await importAllTables(copy, await exportAllTables(db))
    expect(await copy.exec('SELECT * FROM images')).toEqual(await db.exec('SELECT * FROM images'))
    expect(await hashDatabase(copy)).toBe(await hashDatabase(db))
  } finally {
    await db.close()
    await copy.close()
  }
})
