import { GitHubCsvBackend } from './GitHubCsvBackend'
import { GitHubTransport } from './GitHubTransport'
import { SqliteBlobBackend } from './SqliteBlobBackend'
import { SupabaseStorageTransport } from './SupabaseStorageTransport'
import { S3Transport } from './S3Transport'
import type { SyncBackend } from './SyncBackend'
import type { ProviderConfig } from './localState/providerConfig'

/**
 * Pure factory from a ProviderConfig to the matching SyncBackend, or null
 * when sync is off. Called by init.ts at app launch and again whenever the
 * user changes provider settings (so no reload is needed).
 *
 * Object keys for the blob path are hard-coded — keeping them out of
 * providerConfig prevents the user from typing them wrong and avoids one
 * more form field. Users who want a different layout can fork.
 */
export function buildBackend(cfg: ProviderConfig): SyncBackend | null {
  switch (cfg.active) {
    case 'none':
      return null
    case 'github':
      return new GitHubCsvBackend(new GitHubTransport(cfg.github))
    case 'supabase':
      return new SqliteBlobBackend(
        new SupabaseStorageTransport(cfg.supabase, 'db.sqlite', 'db.sqlite.json'),
      )
    case 's3':
      return new SqliteBlobBackend(
        new S3Transport(cfg.s3, cfg.s3.objectKey, `${cfg.s3.objectKey}.json`),
      )
    default:
      // Unknown kind (stored by a newer build): sync off. Without this the
      // function would return undefined, which callers don't expect.
      return null
  }
}
