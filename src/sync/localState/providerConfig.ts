import { jsonStore } from './storage'

// Sync-provider configuration. All three credential blocks are persisted
// regardless of which one is active, so the user can switch providers
// without losing settings. The realistic threat against tokens stored here
// is XSS, which already exfiltrates the entire SQLite database, so at-rest
// encryption of these fields would not raise the bar. See the design doc
// (docs/plans/2026-05-27-sync-settings-design.md, "Secrets stored
// plaintext in localStorage") for the full reasoning.

export type SyncProviderKind = 'none' | 'supabase' | 's3' | 'github'

export interface SupabaseConfig {
  url: string
  anonKey: string
  bucket: string
}

export interface S3Config {
  endpoint: string
  region: string
  accessKeyId: string
  secretKey: string
  bucket: string
  objectKey: string
}

export interface GitHubConfig {
  repo: string
  branch: string
  token: string
}

export interface ProviderConfig {
  active: SyncProviderKind
  supabase: SupabaseConfig
  s3: S3Config
  github: GitHubConfig
}

export const EMPTY_PROVIDER_CONFIG: ProviderConfig = {
  active: 'none',
  supabase: { url: '', anonKey: '', bucket: 'moneytracker' },
  s3: {
    endpoint: '',
    region: 'auto',
    accessKeyId: '',
    secretKey: '',
    bucket: 'moneytracker',
    objectKey: 'moneytracker.sqlite',
  },
  github: { repo: '', branch: 'main', token: '' },
}

const slot = jsonStore<ProviderConfig>('providerConfig', EMPTY_PROVIDER_CONFIG)

const PROVIDER_KINDS: readonly SyncProviderKind[] = ['none', 'supabase', 's3', 'github']

export function loadProviderConfig(): ProviderConfig {
  const cfg = slot.load()
  // A value from a newer build, or a hand-edited one, must not select a
  // provider this build doesn't know.
  if (!PROVIDER_KINDS.includes(cfg.active)) cfg.active = 'none'
  return cfg
}

export function saveProviderConfig(config: ProviderConfig): void {
  slot.save(config)
}
