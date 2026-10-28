import { describe, it, expect } from 'vitest'
import { badgeFace } from '../face'
import { emojiTints } from '../colours'
import { primeIcon } from '../sets'
import { emojiIcon, imageIcon, setIcon } from '../types'
import { asUuid } from '@/db/uuid'

const SHOP = primeIcon('shop')
const IMAGE = asUuid('9a5834b6-061b-5ec2-a5d0-9d6ae48cb098')
const glyph = (className: string, background = '#1e3a8a', foreground = '#ffffff') => ({
  kind: 'glyph',
  className,
  background,
  foreground,
})

describe('badgeFace', () => {
  it('draws a pack icon in a readable colour on the colour', () => {
    expect(badgeFace(primeIcon('gift'), '#1e3a8a', SHOP)).toEqual(glyph('pi pi-gift'))
    expect(badgeFace(primeIcon('gift'), '#fde047', SHOP)).toEqual(
      glyph('pi pi-gift', '#fde047', '#111827'),
    )
  })

  it('draws an emoji on a tint of the colour', () => {
    expect(badgeFace(emojiIcon('🛒'), '#ef4444', SHOP)).toEqual({
      kind: 'emoji',
      emoji: '🛒',
      tints: emojiTints('#ef4444'),
    })
  })

  it('draws a picture ringed by the colour, once it is read', () => {
    const view = { url: 'data:image/webp;base64,AAAA', fills: false }
    expect(badgeFace(imageIcon(IMAGE), '#ef4444', SHOP, view)).toEqual({
      kind: 'image',
      url: view.url,
      fills: false,
      ring: '#ef4444',
    })
    expect(badgeFace(imageIcon(IMAGE), '#ef4444', SHOP, { ...view, fills: true })).toMatchObject({
      fills: true,
    })
  })

  it('draws the default icon for a picture loading or missing', () => {
    expect(badgeFace(imageIcon(IMAGE), '#1e3a8a', SHOP, undefined)).toEqual(glyph('pi pi-shop'))
    expect(badgeFace(imageIcon(IMAGE), '#1e3a8a', SHOP, null)).toEqual(glyph('pi pi-shop'))
  })

  it('draws the default icon for an unknown kind, pack or name', () => {
    for (const icon of [
      { kind: 'unknown', json: '{"kind":"sticker"}' } as const,
      setIcon('material', 'storefront'),
      primeIcon('no-such-icon'),
    ]) {
      expect(badgeFace(icon, '#1e3a8a', SHOP)).toEqual(glyph('pi pi-shop'))
    }
  })
})
