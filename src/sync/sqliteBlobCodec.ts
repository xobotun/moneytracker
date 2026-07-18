import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js'
import { Database } from '../db/Database'
import { newId } from '../db/uuid'

// Blob ↔ Database round-trip for SqliteBlobBackend (Supabase Storage / S3
// transports). Counterpart to csvCodec.ts, but the wire format is a whole
// .sqlite file's bytes rather than per-table CSV.
//
// Recipe (see MEMORY reference_sqlite_export.md): `VACUUM INTO` a fresh
// MemoryVFS-backed file gives us an atomic, compacted snapshot of the
// source database as a contiguous in-memory byte array — no need to read
// IndexedDB pages or shell out to sqlite3_serialize (which wa-sqlite's JS
// API doesn't expose). Import is the mirror image: pre-load a MemoryVFS
// with the blob's bytes *before* opening a Database against it, so
// wa-sqlite's xOpen finds an already-populated file instead of creating an
// empty one.
//
// Each call registers its own MemoryVFS instance under a fresh random name
// (via newId()) rather than reusing a shared one. wa-sqlite has no
// vfs_unregister in its JS API, so repeat registrations under a fixed name
// would pile up in the C-side VFS list; fresh names sidestep that instead
// of relying on "last registered wins" lookup behavior.

/**
 * Exports `db`'s content as raw SQLite file bytes via `VACUUM INTO` a
 * MemoryVFS-backed target file. Read-only against `db`: VACUUM INTO writes
 * to the separate target file, not the source connection, so this does not
 * bump `db.mutationCounter` (the counter only tracks INSERT/UPDATE/DELETE/
 * REPLACE/ALTER/CREATE/DROP via run()'s leading-keyword check, and `VACUUM`
 * doesn't match any of those).
 */
export async function exportDatabaseToBlob(db: Database): Promise<Uint8Array> {
  const vfs = new MemoryVFS()
  // MemoryVFS.name defaults to 'memory' on every instance; give this one a
  // unique name so a URI naming it can't collide with another export VFS
  // registered earlier on the same connection.
  vfs.name = `sqliteBlobCodec-export-${newId()}`
  // wa-sqlite's own .d.ts is internally inconsistent: `VFS.Base` (which
  // MemoryVFS extends) types xRead/xWrite's `pData` as `{ size, value }`,
  // while the `SQLiteVFS` interface (expected by `vfs_register` /
  // DatabaseOptions.vfs) types it as a plain `Uint8Array`. Both describe
  // the same runtime object; this is an upstream typing gap, not a real
  // incompatibility.
  db.registerVfs(vfs as unknown as SQLiteVFS)

  const fileName = `export-${newId()}`
  await db.run(`VACUUM INTO 'file:${fileName}?vfs=${vfs.name}'`)

  // This VFS instance is fresh and used for exactly this one VACUUM INTO
  // call, so it holds exactly one file — but wa-sqlite's URI parsing passes
  // xOpen the full "name?vfs=..." string as the file name (the query
  // string is not stripped before reaching the VFS layer), so looking up
  // by the bare `fileName` misses. Read back whatever got stored instead of
  // assuming the exact key.
  if (vfs.mapNameToFile.size !== 1) {
    throw new Error(
      `sqliteBlobCodec.exportDatabaseToBlob: expected exactly 1 file in export VFS, got ${vfs.mapNameToFile.size}`,
    )
  }
  const [file] = vfs.mapNameToFile.values() as IterableIterator<{
    data: ArrayBuffer
    size: number
  }>
  if (!file) {
    throw new Error('sqliteBlobCodec.exportDatabaseToBlob: VACUUM INTO produced no output file')
  }
  // file.data may be larger than file.size (MemoryVFS doubles its backing
  // ArrayBuffer on growth rather than resizing exactly); slice to the
  // logical size to get exactly the bytes SQLite wrote.
  const bytes = new Uint8Array(file.data.slice(0, file.size))
  // Clear the VFS's file map to prevent unbounded memory retention on
  // long-lived source connections that repeatedly call exportDatabaseToBlob.
  // ArrayBuffer.slice() already produced an independent copy, so clearing
  // after slicing is safe. The (now-empty) VFS registration itself is still
  // permanently retained on the module, but that's a fixed-cost residual.
  vfs.mapNameToFile.clear()
  return bytes
}

/**
 * Opens a fresh Database whose content is `blob`'s bytes, by pre-loading a
 * MemoryVFS with those bytes before opening — wa-sqlite's xOpen sees an
 * already-populated file and uses it as-is instead of creating an empty one.
 */
export async function openDatabaseFromBlob(blob: Uint8Array): Promise<Database> {
  const vfs = new MemoryVFS()
  vfs.name = `sqliteBlobCodec-import-${newId()}`

  const fileName = `import-${newId()}`
  // Copy the blob into a fresh, offset-safe ArrayBuffer: `blob.buffer` may
  // be larger than `blob` itself (a view into a bigger allocation), and
  // MemoryVFS's xRead/xWrite index directly into `file.data` from byte 0.
  const data = blob.slice().buffer
  vfs.mapNameToFile.set(fileName, {
    name: fileName,
    flags: 0,
    size: data.byteLength,
    data,
  })

  const db = new Database()
  // See the comment in exportDatabaseToBlob about this cast.
  await db.init({ filePath: fileName, vfs: vfs as unknown as SQLiteVFS })
  return db
}
