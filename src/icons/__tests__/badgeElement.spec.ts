import { describe, it, expect } from 'vitest'
import { badgeElement } from '../badgeElement'
import { badgeFace } from '../face'
import { primeIcon } from '../sets'
import { emojiIcon, imageIcon, setIcon } from '../types'
import { asUuid } from '@/db/uuid'

const SHOP = primeIcon('shop')
const IMAGE = asUuid('9a5834b6-061b-5ec2-a5d0-9d6ae48cb098')
const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>'

describe('badgeElement', () => {
  it('draws a pack icon on the colour', () => {
    const el = badgeElement(badgeFace(primeIcon('gift'), '#1e3a8a', SHOP))
    expect(el.dataset.face).toBe('glyph')
    expect(el.style.backgroundColor).toBe('rgb(30, 58, 138)')
    expect(el.style.color).toBe('rgb(255, 255, 255)')
    expect(el.querySelector('.pi-gift')).not.toBeNull()
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws an emoji on the tint, as text', () => {
    const el = badgeElement(badgeFace(emojiIcon('🛒'), '#ef4444', SHOP))
    expect(el.dataset.face).toBe('emoji')
    expect(el.textContent).toBe('🛒')
    expect(el.style.getPropertyValue('--tint-light')).toMatch(/^#[0-9a-f]{6}$/)
    expect(el.style.getPropertyValue('--tint-dark')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('keeps markup in an emoji as text', () => {
    const el = badgeElement(badgeFace(emojiIcon(HOSTILE), '#ef4444', SHOP))
    expect(el.textContent).toBe(HOSTILE)
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('img')).toBeNull()
  })

  it('draws a picture as an image ringed by the colour', () => {
    const url = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'
    const upload = badgeElement(badgeFace(imageIcon(IMAGE), '#ef4444', SHOP, { url, fills: false }))
    expect(upload.dataset.face).toBe('image')
    expect(upload.style.borderColor).toBe('rgb(239, 68, 68)')
    const img = upload.querySelector('img')!
    expect(img.getAttribute('src')).toBe(url)
    expect(img.alt).toBe('')
    expect(img.className).toContain('p-[15%]')
    const word = badgeElement(badgeFace(imageIcon(IMAGE), '#ef4444', SHOP, { url, fills: true }))
    expect(word.querySelector('img')!.className).not.toContain('p-[15%]')
  })

  it('never turns an unknown icon’s name into markup', () => {
    const el = badgeElement(badgeFace(setIcon('pi', HOSTILE), '#ef4444', SHOP))
    expect(el.innerHTML).toBe('<span class="pi pi-shop"></span>')
  })

  it('keeps a colour that is no colour out of the style', () => {
    const el = badgeElement(badgeFace(primeIcon('gift'), 'red; background-image: url(x)', SHOP))
    expect(el.style.backgroundImage).toBe('')
  })
})
