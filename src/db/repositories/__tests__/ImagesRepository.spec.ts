import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from '../../Database'
import { runMigrations } from '../../migrations'
import { migration as settingsMigration } from '../../migrations/001_settings'
import { migration as domainMigration } from '../../migrations/002_domain_schema'
import { ImagesRepository, imageId } from '../ImagesRepository'
import type { ImageMediaType } from '../../types'
import { asUuid } from '../../uuid'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5"/></svg>'
const WEBP = 'UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='

describe('ImagesRepository', () => {
  let db: Database
  let repo: ImagesRepository

  beforeEach(async () => {
    db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    repo = new ImagesRepository(db)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await db.close()
  })

  const count = async () => (await db.exec<{ n: number }>('SELECT COUNT(*) AS n FROM images'))[0]!.n

  it('derives a UUIDv5 from the content: the same picture gets the same id', async () => {
    const id = await imageId(SVG)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await imageId(SVG)).toBe(id)
    expect(await imageId(WEBP)).not.toBe(id)
    // Pinned: ids are synced, so the derivation must never change.
    expect(await imageId('')).toBe('9a5834b6-061b-5ec2-a5d0-9d6ae48cb098')
  })

  it('stores an image and reads it back', async () => {
    const id = await repo.put({
      mediaType: 'image/webp',
      content: WEBP,
      width: 1,
      height: 1,
    })
    expect(id).toBe(await imageId(WEBP))
    expect(await repo.get(id)).toMatchObject({
      id,
      media_type: 'image/webp',
      content: WEBP,
      width: 1,
      height: 1,
      source: null,
      deleted_at_utc: null,
    })
  })

  it('keeps a word’s settings and an unknown size', async () => {
    const source = { text: 'C&A', font: 'sans', bold: true }
    const id = await repo.put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: null,
      height: null,
      source,
    })
    expect(await repo.get(id)).toMatchObject({ width: null, height: null, source })
  })

  it('writes nothing when the same picture is put again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T10:00:00.000Z'))
    const first = await repo.put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: 10,
      height: 10,
    })
    vi.setSystemTime(new Date('2026-10-28T11:00:00.000Z'))
    const again = await repo.put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: 20,
      height: 20,
      source: { text: 'other' },
    })
    expect(again).toBe(first)
    expect(await count()).toBe(1)
    expect(await repo.get(first)).toMatchObject({
      width: 10,
      source: null,
      created_at_utc: new Date('2026-10-28T10:00:00.000Z'),
      updated_at_utc: new Date('2026-10-28T10:00:00.000Z'),
    })
  })

  it('refuses a media type other than WebP and SVG', async () => {
    await expect(
      repo.put({
        mediaType: 'image/png' as ImageMediaType,
        content: 'iVBORw0KGgo=',
        width: 1,
        height: 1,
      }),
    ).rejects.toThrow(/CHECK/)
    expect(await count()).toBe(0)
  })

  it('finds nothing for an unknown id', async () => {
    expect(await repo.get(asUuid('00000000-0000-5000-8000-000000000000'))).toBeNull()
  })
})
