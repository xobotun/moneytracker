/**
 * Storage primitives the SqliteBlobBackend needs. Conditional PUT with
 * If-Match is the CAS handle: GET the sidecar to capture an ETag, then
 * PUT the new sidecar with If-Match: <etag>. 412 Precondition Failed
 * means another writer beat us — we treat that as CAS miss.
 *
 * The blob (db.sqlite) is uploaded without a conditional check; the
 * sidecar PUT is what serialises updates.
 */
export interface BlobTransport {
  /** Where the blob lives, without credentials: see `SyncBackend.remoteId`. */
  readonly remoteId: string

  /** GET the metadata sidecar. null = not yet uploaded. */
  getSidecar(): Promise<{ text: string; etag: string } | null>

  /** Unconditionally PUT the database blob bytes. */
  putBlob(bytes: Uint8Array): Promise<void>

  /**
   * Conditional PUT of the sidecar.
   *  - expectedEtag === null → If-None-Match: * (only if sidecar doesn't exist).
   *  - expectedEtag !== null → If-Match: <etag>.
   * Returns false on 412 (CAS miss); throws on other non-2xx.
   */
  putSidecar(text: string, expectedEtag: string | null): Promise<boolean>

  /** GET the database blob. Throws if missing (caller checks sidecar first). */
  getBlob(): Promise<Uint8Array>

  /** Auth-only smoke check for the Settings UI Validate button. */
  validate(): Promise<void>
}
