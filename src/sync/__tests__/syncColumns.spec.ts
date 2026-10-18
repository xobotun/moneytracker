import { describe, it, expect } from 'vitest'
import { Database } from '../../db/Database'
import { runMigrations } from '../../db/migrations'
import { migration as settingsMigration } from '../../db/migrations/001_settings'
import { migration as domainMigration } from '../../db/migrations/002_domain_schema'
import { SYNC_COLUMNS, type ColumnDescriptor } from '../syncColumns'
import { SYNC_TABLES } from '../syncTables'

interface PragmaRow {
  cid: number
  name: string
  type: string
  notnull: 0 | 1
  dflt_value: string | null
  pk: 0 | 1
  [key: string]: unknown
}

describe('SYNC_COLUMNS', () => {
  it('declares descriptors for every domain table in SYNC_TABLES', () => {
    for (const table of SYNC_TABLES) {
      expect(SYNC_COLUMNS[table.name], `missing descriptor for ${table.name}`).toBeDefined()
      expect(SYNC_COLUMNS[table.name]!.length).toBeGreaterThan(0)
    }
  })

  it('describes each domain table exactly as the schema declares it', async () => {
    const db = new Database()
    await db.init()
    await runMigrations(db, [settingsMigration, domainMigration])
    try {
      for (const table of SYNC_TABLES) {
        const declared = SYNC_COLUMNS[table.name]!
        const pragma = await db.exec<PragmaRow>(`PRAGMA table_info(${table.name})`)

        // Names + order match exactly.
        expect(
          declared.map((c) => c.name),
          `column order mismatch on ${table.name}`,
        ).toEqual(pragma.map((r) => r.name))

        // Type affinity matches.
        for (let i = 0; i < declared.length; i++) {
          const d = declared[i]!
          const p = pragma[i]!
          const affinity = affinityOf(p.type)
          expect(d.sqlType, `${table.name}.${d.name} sqlType`).toBe(affinity)
          expect(d.nullable, `${table.name}.${d.name} nullable`).toBe(p.notnull === 0)
        }
      }
    } finally {
      await db.close()
    }
  })
})

function affinityOf(declared: string): ColumnDescriptor['sqlType'] {
  // Per CLAUDE.md, the project pins declared types to TEXT / INTEGER / REAL.
  // Anything else is a bug in either the schema or the descriptor.
  const t = declared.toUpperCase()
  if (t === 'TEXT') return 'TEXT'
  if (t === 'INTEGER') return 'INTEGER'
  if (t === 'REAL') return 'REAL'
  throw new Error(`unexpected column type "${declared}" — project uses only TEXT/INTEGER/REAL`)
}
