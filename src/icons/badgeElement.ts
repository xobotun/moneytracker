import {
  EMOJI_DISC_CLASS,
  IMAGE_CLASS,
  IMAGE_DISC_CLASS,
  INSET_IMAGE_CLASS,
  type BadgeFace,
} from './face'

/**
 * A badge as a DOM element, for places Vue does not render (Leaflet's map
 * pins). The caller sizes it and draws its border. Built with DOM APIs, never
 * HTML text: the emoji, the colour and the picture are user data.
 */
export function badgeElement(face: BadgeFace): HTMLElement {
  const disc = document.createElement('span')
  disc.setAttribute('aria-hidden', 'true')
  disc.dataset.face = face.kind
  if (face.kind === 'glyph') {
    disc.style.backgroundColor = face.background
    disc.style.color = face.foreground
    const glyph = document.createElement('span')
    glyph.className = face.className
    disc.append(glyph)
  } else if (face.kind === 'emoji') {
    disc.className = EMOJI_DISC_CLASS
    disc.style.setProperty('--tint-light', face.tints.light)
    disc.style.setProperty('--tint-dark', face.tints.dark)
    const emoji = document.createElement('span')
    emoji.textContent = face.emoji
    disc.append(emoji)
  } else {
    disc.className = IMAGE_DISC_CLASS
    disc.style.borderColor = face.ring
    const img = document.createElement('img')
    img.alt = ''
    img.src = face.url
    img.className = face.fills ? IMAGE_CLASS : `${IMAGE_CLASS} ${INSET_IMAGE_CLASS}`
    disc.append(img)
  }
  return disc
}
