import { RASTER_QUALITY, base64, encodedMediaType, rasterLayout } from './raster'

/** A raster picture ready to store: square, at most 256 pixels a side. */
export interface EncodedRaster {
  mediaType: 'image/webp' | 'image/png'
  /** Base64 of the encoded file. */
  content: string
  /** Width and height: the canvas is square. */
  side: number
}

/** The file is no picture this browser can decode. */
export class NotAnImageError extends Error {}

/**
 * Decodes `file` (a GIF's first frame), draws it fitted within 256 × 256 on
 * a transparent square canvas and encodes that as WebP — or PNG, where the
 * browser cannot write WebP.
 */
export async function encodeRaster(file: Blob): Promise<EncodedRaster> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (e) {
    throw new NotAnImageError(`This file is not an image: ${String(e)}`)
  }
  try {
    const layout = rasterLayout(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = layout.side
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot draw pictures (no 2D canvas).')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, layout.x, layout.y, layout.width, layout.height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', RASTER_QUALITY),
    )
    const mediaType = blob ? encodedMediaType(blob.type) : null
    if (!blob || !mediaType) throw new Error(`The browser encoded the picture as ${blob?.type}.`)
    return {
      mediaType,
      content: base64(new Uint8Array(await blob.arrayBuffer())),
      side: layout.side,
    }
  } finally {
    bitmap.close()
  }
}
