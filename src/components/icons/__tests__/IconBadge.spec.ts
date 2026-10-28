import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { Database } from '@/db/Database'
import { ALL_MIGRATIONS, runMigrations } from '@/db/migrations'
import { ImagesRepository, imageId } from '@/db/repositories/ImagesRepository'
import { primeIcon } from '@/icons/sets'
import { emojiIcon, imageIcon, setIcon, type Icon } from '@/icons/types'
import { settle } from '@/components/tags/__tests__/dom'
import IconBadge from '../IconBadge.vue'

let repo: ImagesRepository
vi.mock('@/db/init', () => ({ getImagesRepository: () => repo }))

const SHOP = primeIcon('shop')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'

describe('IconBadge', () => {
  let db: Database

  beforeEach(async () => {
    setActivePinia(createPinia())
    db = new Database()
    await db.init()
    await runMigrations(db, ALL_MIGRATIONS)
    repo = new ImagesRepository(db)
  })

  afterEach(async () => {
    await db.close()
  })

  async function draw(icon: Icon, extra: Record<string, unknown> = {}) {
    const wrapper = mount(IconBadge, {
      props: { icon, colour: '#1e3a8a', fallback: SHOP, ...extra },
    })
    await settle()
    return wrapper
  }

  it('draws a pack icon in a readable colour on the colour', async () => {
    const w = await draw(primeIcon('gift'))
    expect(w.attributes('data-face')).toBe('glyph')
    expect(w.attributes('style')).toContain('background-color: rgb(30, 58, 138)')
    expect(w.find('.pi-gift').exists()).toBe(true)
    expect(w.attributes('aria-hidden')).toBe('true')
  })

  it('draws an emoji on a tint of the colour', async () => {
    const w = await draw(emojiIcon('🛒'))
    expect(w.attributes('data-face')).toBe('emoji')
    expect(w.text()).toBe('🛒')
    expect(w.classes()).toContain('bg-(--tint-light)')
    expect(w.attributes('style')).toMatch(/--tint-light: #[0-9a-f]{6}/)
  })

  it('keeps markup in an emoji as text', async () => {
    const w = await draw(emojiIcon('<script>alert(1)</script>'))
    expect(w.text()).toBe('<script>alert(1)</script>')
    expect(w.find('script').exists()).toBe(false)
  })

  it('draws a picture once it is read, ringed by the colour', async () => {
    const id = await repo.put({ mediaType: 'image/svg+xml', content: SVG, width: 1, height: 1 })
    const w = await draw(imageIcon(id))
    expect(w.attributes('data-face')).toBe('image')
    expect(w.find('img').attributes('src')).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`,
    )
    expect(w.find('img').attributes('alt')).toBe('')
    expect(w.attributes('style')).toContain('border-color: rgb(30, 58, 138)')
  })

  it('draws the default icon while a picture is missing', async () => {
    const w = await draw(imageIcon(await imageId(SVG)))
    expect(w.attributes('data-face')).toBe('glyph')
    expect(w.find('.pi-shop').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(false)
  })

  it('draws the default icon for an unknown kind or pack', async () => {
    for (const icon of [
      { kind: 'unknown', json: '{"kind":"sticker","id":7}' } as const,
      setIcon('material', 'storefront'),
    ]) {
      const w = await draw(icon)
      expect(w.attributes('data-face')).toBe('glyph')
      expect(w.find('.pi-shop').exists()).toBe(true)
    }
  })

  it('inline, keeps a pack icon a bare icon in the colour, and other kinds a tiny badge', async () => {
    const bare = await draw(primeIcon('gift'), { inline: true })
    expect(bare.element.tagName).toBe('SPAN')
    expect(bare.classes()).toEqual(['pi', 'pi-gift'])
    expect(bare.attributes('style')).toBe('color: rgb(30, 58, 138);')

    const emoji = await draw(emojiIcon('🛒'), { inline: true })
    expect(emoji.attributes('data-face')).toBe('emoji')
    expect(emoji.classes()).toContain('size-[1.4em]')
  })

  it('sizes the badge', async () => {
    expect((await draw(SHOP, { small: true })).classes()).toContain('size-8')
    expect((await draw(SHOP)).classes()).toContain('size-10')
    expect((await draw(SHOP, { large: true })).classes()).toContain('size-12')
  })
})
