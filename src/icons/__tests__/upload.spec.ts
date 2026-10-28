import { describe, it, expect, vi } from 'vitest'
import { cleanSvg } from '../svgClean'
import type { EncodedRaster } from '../rasterEncode'
import {
  MAX_IMAGE_BYTES,
  WARN_IMAGE_BYTES,
  UploadError,
  formatBytes,
  isSvgFile,
  prepareUpload,
  sizeVerdict,
  type UploadTools,
} from '../upload'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect width="24" height="12"/></svg>'

/** An SVG of about `bytes`, padded with paths that survive cleaning. */
function bigSvg(bytes: number): string {
  const path = '<path d="M0 0L1 1L2 2L3 3L4 4L5 5L6 6L7 7L8 8L9 9"/>'
  const count = Math.ceil(bytes / path.length)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${path.repeat(count)}</svg>`
}

const PNG: EncodedRaster = { mediaType: 'image/png', content: 'iVBORw0KGgoAAAA=', side: 200 }

function tools(raster: Partial<EncodedRaster> | Error = {}): UploadTools {
  return {
    cleanSvg,
    encodeRaster: vi.fn(async () => {
      if (raster instanceof Error) throw raster
      return { ...PNG, ...raster }
    }),
  }
}

describe('sizeVerdict', () => {
  it('stores up to 100 KB, warns up to 1 MB, refuses more', () => {
    expect(sizeVerdict(0)).toBe('ok')
    expect(sizeVerdict(WARN_IMAGE_BYTES)).toBe('ok')
    expect(sizeVerdict(WARN_IMAGE_BYTES + 1)).toBe('warn')
    expect(sizeVerdict(MAX_IMAGE_BYTES)).toBe('warn')
    expect(sizeVerdict(MAX_IMAGE_BYTES + 1)).toBe('refuse')
  })

  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(150 * 1024)).toBe('150 KB')
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB')
  })
})

describe('prepareUpload', () => {
  it('knows an SVG by its type or its name', () => {
    expect(isSvgFile({ name: 'logo', type: 'image/svg+xml' })).toBe(true)
    expect(isSvgFile({ name: 'logo.SVG', type: '' })).toBe(true)
    expect(isSvgFile({ name: 'logo.svg', type: 'text/xml' })).toBe(true)
    expect(isSvgFile({ name: 'logo.png', type: 'image/png' })).toBe(false)
  })

  it('cleans an SVG and keeps it vector, sized by its viewBox', async () => {
    const file = new File([SVG.replace('<rect', '<script>alert(1)</script><rect')], 'logo.svg', {
      type: 'image/svg+xml',
    })
    const prepared = await prepareUpload(file, tools())
    expect(prepared.input).toEqual({
      mediaType: 'image/svg+xml',
      content: SVG,
      width: 24,
      height: 12,
    })
    expect(prepared.url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(prepared.warn).toBe(false)
    expect(prepared.bytes).toBe(SVG.length)
  })

  it('warns about an SVG over 100 KB after cleaning, but allows it', async () => {
    const file = new File([bigSvg(150 * 1024)], 'big.svg', { type: 'image/svg+xml' })
    const prepared = await prepareUpload(file, tools())
    expect(prepared.warn).toBe(true)
    expect(prepared.bytes).toBeGreaterThan(WARN_IMAGE_BYTES)
  })

  it('does not warn when cleaning brings an SVG under 100 KB', async () => {
    const junk = `<script>${'x'.repeat(150 * 1024)}</script>`
    const file = new File([SVG.replace('<rect', `${junk}<rect`)], 'padded.svg', {
      type: 'image/svg+xml',
    })
    expect((await prepareUpload(file, tools())).warn).toBe(false)
  })

  it('refuses an SVG over 1 MB without reading it', async () => {
    const file = new File([bigSvg(MAX_IMAGE_BYTES + 10)], 'huge.svg', { type: 'image/svg+xml' })
    const text = vi.spyOn(file, 'text')
    await expect(prepareUpload(file, tools())).rejects.toThrow(/at most 1\.0 MB/)
    expect(text).not.toHaveBeenCalled()
  })

  it('refuses an .svg that is not an SVG', async () => {
    const file = new File(['<html><body>hi</body></html>'], 'fake.svg', { type: 'image/svg+xml' })
    await expect(prepareUpload(file, tools())).rejects.toThrow(
      new UploadError('This file is not an SVG image.'),
    )
  })

  it('scales a raster picture down and stores what the browser encoded', async () => {
    const t = tools()
    const file = new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' })
    const prepared = await prepareUpload(file, t)
    expect(t.encodeRaster).toHaveBeenCalledWith(file)
    expect(prepared.input).toEqual({
      mediaType: 'image/png',
      content: PNG.content,
      width: 200,
      height: 200,
    })
    expect(prepared.url).toBe(`data:image/png;base64,${PNG.content}`)
    expect(prepared.bytes).toBe(11)
  })

  it('warns about a large encoded picture too', async () => {
    const content = 'A'.repeat(Math.ceil((WARN_IMAGE_BYTES * 4) / 3) + 8)
    const file = new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' })
    expect((await prepareUpload(file, tools({ content, mediaType: 'image/webp' }))).warn).toBe(true)
  })

  it('refuses a file that is no image', async () => {
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    await expect(prepareUpload(text, tools())).rejects.toThrow('This file is not an image.')
    const broken = new File(['nope'], 'broken.png', { type: 'image/png' })
    await expect(prepareUpload(broken, tools(new Error('decode failed')))).rejects.toThrow(
      UploadError,
    )
  })
})
