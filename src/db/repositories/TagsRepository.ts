import type { Database } from '../Database'
import type { Tag } from '../types'

interface TagRow {
  tag: string
  description: string | null
  synonyms: string
  colour: string
  icon: string
  created_at_utc: string
  updated_at_utc: string
  deleted_at_utc: string | null
}

type TagCreateInput = Pick<Tag, 'tag' | 'colour' | 'icon' | 'synonyms'> & {
  description?: string | null
}

type TagUpdateInput = Partial<Pick<Tag, 'description' | 'synonyms' | 'colour' | 'icon'>>

function rowToTag(row: TagRow): Tag {
  return {
    tag: row.tag,
    description: row.description,
    synonyms: JSON.parse(row.synonyms) as string[],
    colour: row.colour,
    icon: row.icon,
    created_at_utc: row.created_at_utc,
    updated_at_utc: row.updated_at_utc,
    deleted_at_utc: row.deleted_at_utc,
  }
}

export class TagsRepository {
  constructor(private db: Database) {}

  async create(input: TagCreateInput): Promise<Tag> {
    const now = new Date().toISOString()
    await this.db.run(
      `INSERT INTO tags (tag, description, synonyms, colour, icon, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.tag,
        input.description ?? null,
        JSON.stringify(input.synonyms),
        input.colour,
        input.icon,
        now,
        now,
      ],
    )
    return (await this.findByName(input.tag))!
  }

  async findByName(tag: string): Promise<Tag | null> {
    const rows = await this.db.exec<TagRow>(
      'SELECT * FROM tags WHERE tag = ? AND deleted_at_utc IS NULL',
      [tag],
    )
    return rows.length === 0 ? null : rowToTag(rows[0]!)
  }

  async list(): Promise<Tag[]> {
    const rows = await this.db.exec<TagRow>(
      'SELECT * FROM tags WHERE deleted_at_utc IS NULL ORDER BY tag',
    )
    return rows.map(rowToTag)
  }

  async update(tag: string, patch: TagUpdateInput): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
    if (patch.synonyms !== undefined)    { sets.push('synonyms = ?');    params.push(JSON.stringify(patch.synonyms)) }
    if (patch.colour !== undefined)      { sets.push('colour = ?');      params.push(patch.colour) }
    if (patch.icon !== undefined)        { sets.push('icon = ?');        params.push(patch.icon) }
    if (sets.length === 0) return
    sets.push('updated_at_utc = ?')
    params.push(new Date().toISOString())
    params.push(tag)
    await this.db.run(`UPDATE tags SET ${sets.join(', ')} WHERE tag = ?`, params)
  }

  async softDelete(tag: string): Promise<void> {
    const now = new Date().toISOString()
    await this.db.run(
      'UPDATE tags SET deleted_at_utc = ?, updated_at_utc = ? WHERE tag = ?',
      [now, now, tag],
    )
  }
}
