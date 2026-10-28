// Raster pictures (PNG, JPEG, WebP, GIF, …) are scaled down on the device to
// fit 256 × 256 (docs/plans/2026-10-28-icons-design.md §3). The maths and the
// decisions live here; rasterEncode.ts does the drawing.

/** The longest side a stored raster picture has. */
export const MAX_RASTER_SIDE = 256
/** WebP quality: logos stay crisp, a photo stays small. */
export const RASTER_QUALITY = 0.9

/** A square canvas and where the picture goes on it. */
export interface RasterLayout {
  /** The canvas is `side` × `side`, transparent around the picture. */
  side: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * Fits a `width` × `height` picture within `max` × `max`, keeping its
 * proportions, centred on a square canvas. Never enlarges: a small picture
 * keeps its pixels (the badge scales it anyway).
 */
export function rasterLayout(width: number, height: number, max = MAX_RASTER_SIDE): RasterLayout {
  if (!(width > 0 && height > 0)) throw new RangeError(`No picture to fit: ${width} × ${height}`)
  const scale = Math.min(1, max / width, max / height)
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const side = Math.max(w, h)
  return { side, x: Math.floor((side - w) / 2), y: Math.floor((side - h) / 2), width: w, height: h }
}

/**
 * What the canvas actually encoded: WebP where the browser can write it,
 * PNG where it cannot (Safari answers a WebP request with PNG). Anything
 * else is null.
 */
export function encodedMediaType(blobType: string): 'image/webp' | 'image/png' | null {
  return blobType === 'image/webp' || blobType === 'image/png' ? blobType : null
}

/** Base64 of `bytes`, in chunks so a large picture does not overflow the call stack. */
export function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
