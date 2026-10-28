import type { Database } from '../Database'
import type { ImageMediaType, StoredImage } from '../types'
import {
  instantFromColumn,
  instantFromNullableColumn,
  instantToColumn,
  jsonObjectFromNullableColumn,
  jsonObjectToCanonicalNullableColumn,
  uuidFromColumn,
} from '../columnMappers'
import { nameBasedId, type UUID } from '../uuid'

type ImageRow = {
  id: string
  media_type: string
  content: string
  width: number | null
  height: number | null
  source: string | null
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

export interface ImagePutInput {
  mediaType: ImageMediaType
  /** Base64 for WebP and PNG, the cleaned markup for SVG. */
  content: string
  width: number | null
  height: number | null
  /** The Text tab's settings for a word (stored with sorted keys); null or left out for an upload. */
  source?: Record<string, unknown> | null
}

/**
 * The id of an image with `content`: a UUIDv5 of the SHA-256 of the stored
 * text (the base64 for WebP and PNG), so the same picture added on two devices is one
 * row. The media type is not part of the key: one text is never both.
 */
export async function imageId(content: string): Promise<UUID> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return nameBasedId('images', hex)
}

function rowToImage(row: ImageRow): StoredImage {
  return {
    id: uuidFromColumn(row.id),
    media_type: row.media_type as ImageMediaType, // the CHECK constraint allows only these
    content: row.content,
    width: row.width,
    height: row.height,
    source: jsonObjectFromNullableColumn<unknown>(row.source),
    created_at_utc: instantFromColumn(row.created_at_utc),
    updated_at_utc: instantFromColumn(row.updated_at_utc),
    deleted_at_utc: instantFromNullableColumn(row.deleted_at_utc),
  }
}

/**
 * The pictures icons show. A row never changes: a new picture is a new row,
 * and putting one that is already there writes nothing.
 */
export class ImagesRepository {
  constructor(private db: Database) {}

  /** Stores the image unless it is already there; either way returns its id. */
  async put(input: ImagePutInput): Promise<UUID> {
    const id = await imageId(input.content)
    const now = instantToColumn(new Date())
    // ON CONFLICT, not INSERT OR IGNORE: that would also swallow a CHECK failure.
    await this.db.run(
      `INSERT INTO images (id, media_type, content, width, height, source, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        input.mediaType,
        input.content,
        input.width,
        input.height,
        jsonObjectToCanonicalNullableColumn(input.source ?? null),
        now,
        now,
      ],
    )
    return id
  }

  async get(id: UUID): Promise<StoredImage | null> {
    const rows = await this.db.exec<ImageRow>(
      'SELECT * FROM images WHERE id = ? AND deleted_at_utc IS NULL',
      [id],
    )
    return rows.length === 0 ? null : rowToImage(rows[0]!)
  }
}
