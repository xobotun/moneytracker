import type { ImagePutInput } from '@/db/repositories/ImagesRepository'
import { imageDataUrl } from './dataUrl'
import type { EncodedRaster } from './rasterEncode'
import type { CleanSvg } from './svgClean'

// What the Image tab does with a chosen file (docs/plans/2026-10-28-icons-
// design.md §3, §5), short of storing it: an SVG is cleaned and stays
// vector, anything else is decoded and scaled down. The cleaner and the
// encoder are passed in — they load lazily, and tests replace them.

/** An SVG file larger than this is refused unread, and so is a picture this large. */
export const MAX_IMAGE_BYTES = 1024 * 1024
/** A picture larger than this syncs to every device slowly: warn, but allow. */
export const WARN_IMAGE_BYTES = 100 * 1024

export type SizeVerdict = 'ok' | 'warn' | 'refuse'

/** Whether a picture of `bytes` is stored as it is, with a warning, or not at all. */
export function sizeVerdict(bytes: number): SizeVerdict {
  if (bytes > MAX_IMAGE_BYTES) return 'refuse'
  if (bytes > WARN_IMAGE_BYTES) return 'warn'
  return 'ok'
}

/** '153 KB', '1.2 MB'. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A file that cannot become an icon; the message is for the user. */
export class UploadError extends Error {}

/** A picture ready to store, and what the tab shows of it. */
export interface PreparedImage {
  input: ImagePutInput
  /** A data URL of the stored form, for the preview. */
  url: string
  /** The stored size: the cleaned markup, or the encoded file. */
  bytes: number
  /** Over WARN_IMAGE_BYTES: the user must confirm. */
  warn: boolean
}

export interface UploadTools {
  cleanSvg(markup: string): CleanSvg
  encodeRaster(file: Blob): Promise<EncodedRaster>
}

/** Whether `file` is meant as an SVG: by its type or its name (systems label .svg differently). */
export function isSvgFile(file: { name: string; type: string }): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
}

/** Whether `file` might be a raster picture: an image type, or no type at all (decoding decides). */
function mayBeRaster(file: { type: string }): boolean {
  return file.type === '' || file.type.startsWith('image/')
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
/** The size of the file a base64 text holds. */
const base64Bytes = (text: string) =>
  Math.floor((text.length * 3) / 4) - text.match(/=*$/)![0].length

function tooBig(bytes: number): UploadError {
  return new UploadError(
    `This picture is ${formatBytes(bytes)}; an icon can be at most ${formatBytes(MAX_IMAGE_BYTES)}.`,
  )
}

/** Turns a chosen file into a picture to store, or throws an UploadError saying why not. */
export async function prepareUpload(file: File, tools: UploadTools): Promise<PreparedImage> {
  if (isSvgFile(file)) {
    if (file.size > MAX_IMAGE_BYTES) throw tooBig(file.size)
    let svg: CleanSvg
    try {
      svg = tools.cleanSvg(await file.text())
    } catch (e) {
      throw new UploadError(e instanceof Error ? e.message : 'This file is not an SVG image.')
    }
    const bytes = utf8Bytes(svg.content)
    const verdict = sizeVerdict(bytes)
    if (verdict === 'refuse') throw tooBig(bytes)
    const input: ImagePutInput = {
      mediaType: 'image/svg+xml',
      content: svg.content,
      width: svg.width,
      height: svg.height,
    }
    return {
      input,
      url: imageDataUrl({ media_type: input.mediaType, content: input.content }),
      bytes,
      warn: verdict === 'warn',
    }
  }

  if (!mayBeRaster(file)) throw new UploadError('This file is not an image.')
  let raster: EncodedRaster
  try {
    raster = await tools.encodeRaster(file)
  } catch (e) {
    console.warn('Could not decode the picture.', e)
    throw new UploadError('This file is not an image this browser can read.')
  }
  const bytes = base64Bytes(raster.content)
  const verdict = sizeVerdict(bytes)
  if (verdict === 'refuse') throw tooBig(bytes)
  const input: ImagePutInput = {
    mediaType: raster.mediaType,
    content: raster.content,
    width: raster.side,
    height: raster.side,
  }
  return {
    input,
    url: imageDataUrl({ media_type: input.mediaType, content: input.content }),
    bytes,
    warn: verdict === 'warn',
  }
}
