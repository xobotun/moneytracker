import { shallowReactive } from 'vue'
import { defineStore } from 'pinia'
import { getImagesRepository } from '@/db/init'
import { imageDataUrl } from '@/icons/dataUrl'
import type { UUID } from '@/db/uuid'

/** An image as a badge draws it. */
export interface ImageView {
  /** A data URL: only ever drawn as an image, where browsers run no scripts and load nothing. */
  url: string
  /** A word made in the Text tab: it fills the circle with its own background. */
  fills: boolean
}

export { imageDataUrl }

/**
 * Images for icons, read by id on demand and kept for the session (rows never
 * change). A miss is kept too, so a badge draws its default icon, but asked
 * again on the next `load`: the image may have synced since.
 */
export const useImagesStore = defineStore('images', () => {
  /** undefined = never asked; null = not in the database (not synced yet). */
  const views = shallowReactive(new Map<UUID, ImageView | null>())
  const loading = new Map<UUID, Promise<void>>()

  /** The image to draw for `id`: undefined while never loaded, null when missing. */
  function view(id: UUID): ImageView | null | undefined {
    return views.get(id)
  }

  /** Reads the image unless it is held or already being read. Never rejects: a failure is a miss. */
  function load(id: UUID): Promise<void> {
    if (views.get(id)) return Promise.resolve()
    const pending = loading.get(id)
    if (pending) return pending
    const read = (async () => {
      try {
        const image = await getImagesRepository().get(id)
        views.set(id, image ? { url: imageDataUrl(image), fills: image.source !== null } : null)
      } catch (e) {
        console.warn(`Could not read the image ${id}; its badge shows the default icon.`, e)
        views.set(id, null)
      } finally {
        loading.delete(id)
      }
    })()
    loading.set(id, read)
    return read
  }

  function loadMany(ids: Iterable<UUID>): Promise<void> {
    return Promise.all([...new Set(ids)].map(load)).then(() => undefined)
  }

  return { view, load, loadMany }
})
