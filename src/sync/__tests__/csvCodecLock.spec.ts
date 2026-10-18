import { describe, it, expect, vi } from 'vitest'
import { exportAllTables } from '../csvCodec'
import { newMigratedDb } from './helpers'

// Hold the papaparse import open until the test releases it, like a slow
// network fetch of the lazily loaded chunk.
const { releaseImport } = vi.hoisted(() => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  ;(globalThis as { __papaGate?: Promise<void> }).__papaGate = gate
  return { releaseImport: () => release() }
})

vi.mock('papaparse', async (importOriginal) => {
  await (globalThis as { __papaGate?: Promise<void> }).__papaGate
  return importOriginal()
})

describe('csvCodec and the database lock', () => {
  it('does not hold the database lock while papaparse is still loading', async () => {
    const db = await newMigratedDb()
    try {
      const exporting = exportAllTables(db)
      // An app query issued meanwhile must not wait for the library download.
      const probe = db.exec('SELECT 1 AS one').then(() => 'query answered')
      const timeout = new Promise((resolve) => setTimeout(() => resolve('query blocked'), 200))
      const first = await Promise.race([probe, timeout])
      releaseImport()
      await exporting
      expect(first).toBe('query answered')
    } finally {
      await db.close()
    }
  })
})
