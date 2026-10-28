import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { ImagesRepository, imageId } from '@/db/repositories/ImagesRepository'
import { imageDataUrl, useImagesStore } from '../images'

let repo: ImagesRepository
vi.mock('@/db/init', () => ({ getImagesRepository: () => repo }))

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text># 100%</text></svg>'
const WEBP = 'UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='

describe('useImagesStore', () => {
  let db: Database

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    repo = new ImagesRepository(db)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.close()
  })

  it('makes a data URL of each media type', () => {
    expect(imageDataUrl({ media_type: 'image/webp', content: WEBP })).toBe(
      `data:image/webp;base64,${WEBP}`,
    )
    expect(imageDataUrl({ media_type: 'image/svg+xml', content: SVG })).toBe(
      'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ctext%3E%23%20100%25%3C%2Ftext%3E%3C%2Fsvg%3E',
    )
  })

  it('reads an image on demand and keeps it for the session', async () => {
    const upload = await repo.put({ mediaType: 'image/webp', content: WEBP, width: 1, height: 1 })
    const word = await repo.put({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: null,
      height: null,
      source: { text: '#' },
    })
    const store = useImagesStore()
    const get = vi.spyOn(repo, 'get')
    expect(store.view(upload)).toBeUndefined()

    await Promise.all([store.load(upload), store.load(upload), store.loadMany([upload, word])])
    expect(store.view(upload)).toEqual({ url: `data:image/webp;base64,${WEBP}`, fills: false })
    expect(store.view(word)).toMatchObject({ fills: true })
    await store.load(upload)
    expect(get).toHaveBeenCalledTimes(2) // once per image
  })

  it('keeps a missing image as missing, and asks again on the next load', async () => {
    const id = await imageId(WEBP)
    const store = useImagesStore()
    await store.load(id)
    expect(store.view(id)).toBeNull()

    await repo.put({ mediaType: 'image/webp', content: WEBP, width: 1, height: 1 }) // synced
    await store.load(id)
    expect(store.view(id)).toMatchObject({ url: `data:image/webp;base64,${WEBP}` })
  })

  it('treats a failed read as a missing image', async () => {
    const id = await imageId(WEBP)
    vi.spyOn(repo, 'get').mockRejectedValue(new Error('disk gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useImagesStore()
    await expect(store.load(id)).resolves.toBeUndefined()
    expect(store.view(id)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})
