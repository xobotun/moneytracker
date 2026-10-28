import type { StoredImage } from '@/db/types'

/** The data URL of a stored image: base64 for raster pictures, the markup for SVG. */
export function imageDataUrl(image: Pick<StoredImage, 'media_type' | 'content'>): string {
  return image.media_type === 'image/svg+xml'
    ? svgDataUrl(image.content)
    : `data:${image.media_type};base64,${image.content}`
}

/** The data URL of SVG markup. */
export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
}
