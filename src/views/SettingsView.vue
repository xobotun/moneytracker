<script setup lang="ts">
import { computed, reactive } from 'vue'
import Card from 'primevue/card'
import Select from 'primevue/select'
import ToggleSwitch from 'primevue/toggleswitch'
import Divider from 'primevue/divider'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import RadioButton from 'primevue/radiobutton'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useSettingsOptions } from './useSettingsOptions'
import { useSyncSettings } from './useSyncSettings'
import { getDatabase, getSyncBackend } from '@/db/init'
import { GitHubTransport } from '@/sync/GitHubTransport'
import { SupabaseStorageTransport } from '@/sync/SupabaseStorageTransport'
import { S3Transport } from '@/sync/S3Transport'

const {
  layoutStore,
  themePresetOptions,
  selectedPreset,
  onPresetChange,
  onDarkModeChange,
  navPositionOptions,
  selectedNavPosition,
  onNavPositionChange,
  collapseModeOptions,
  selectedCollapseMode,
  onCollapseModeChange,
  showCollapseMode,
} = useSettingsOptions()

// The backend is registered by the External-sync plan; for now it returns null
// and the "Current local database" row will render its "not available" state.
const sync = useSyncSettings({ db: getDatabase(), backend: getSyncBackend() })

// getSyncBackend() reads the backend registered at app launch from the
// stored provider config. This is read once at mount, not reactive to
// in-page provider-config edits — matching the minimal UI slice's scope.
const backendAvailable = computed(() => getSyncBackend() !== null)

// Show a short hash (first 8 chars) inline, full value as a tooltip via `title`.
function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—'
  return hash.length > 8 ? hash.slice(0, 8) + '…' : hash
}

function formatInstant(iso: string | null | undefined): string {
  if (!iso) return '—'
  // Display in the user's locale; the raw ISO string lives in the tooltip.
  return new Date(iso).toLocaleString()
}

const localHashMatchesLastSync = computed(() => {
  const local = sync.localHash.value
  const last = sync.lastKnownRemoteState.value?.hash
  return local !== null && last !== undefined && local === last
})

// Validate is an auth-only ping — it builds a transport directly from the
// in-form provider config, not from getSyncBackend(). getSyncBackend()
// returns the CONFIGURED (active) backend, which may be a different
// provider than the one the user is currently editing/validating.
type ValidateStatus = 'idle' | 'ok' | 'fail'
const validating = reactive<{ supabase: boolean; s3: boolean; github: boolean }>({
  supabase: false,
  s3: false,
  github: false,
})
const validateStatus = reactive<{ supabase: ValidateStatus; s3: ValidateStatus; github: ValidateStatus }>({
  supabase: 'idle',
  s3: 'idle',
  github: 'idle',
})
const validateMessage = reactive<{ supabase: string; s3: string; github: string }>({
  supabase: '',
  s3: '',
  github: '',
})

const canValidateGitHub = computed(
  () => !!sync.providerConfig.value.github.repo && !!sync.providerConfig.value.github.token,
)
const canValidateSupabase = computed(
  () => !!sync.providerConfig.value.supabase.url && !!sync.providerConfig.value.supabase.anonKey,
)
const canValidateS3 = computed(
  () =>
    !!sync.providerConfig.value.s3.endpoint &&
    !!sync.providerConfig.value.s3.accessKeyId &&
    !!sync.providerConfig.value.s3.secretKey,
)

async function onValidateGitHub(): Promise<void> {
  validating.github = true
  try {
    const t = new GitHubTransport(sync.providerConfig.value.github)
    await t.validate()
    validateStatus.github = 'ok'
    validateMessage.github = ''
  } catch (e) {
    validateStatus.github = 'fail'
    validateMessage.github = (e as Error).message
  } finally {
    validating.github = false
  }
}

async function onValidateSupabase(): Promise<void> {
  validating.supabase = true
  try {
    const t = new SupabaseStorageTransport(sync.providerConfig.value.supabase, 'db.sqlite', 'db.sqlite.json')
    await t.validate()
    validateStatus.supabase = 'ok'
    validateMessage.supabase = ''
  } catch (e) {
    validateStatus.supabase = 'fail'
    validateMessage.supabase = (e as Error).message
  } finally {
    validating.supabase = false
  }
}

async function onValidateS3(): Promise<void> {
  validating.s3 = true
  try {
    const cfg = sync.providerConfig.value.s3
    const t = new S3Transport(cfg, cfg.objectKey, `${cfg.objectKey}.json`)
    await t.validate()
    validateStatus.s3 = 'ok'
    validateMessage.s3 = ''
  } catch (e) {
    validateStatus.s3 = 'fail'
    validateMessage.s3 = (e as Error).message
  } finally {
    validating.s3 = false
  }
}
</script>

<template>
  <Card>
    <template #title>Settings</template>
    <template #content>
      <Divider align="left" type="solid">
        <b>Visual</b>
      </Divider>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="theme-preset">Theme preset</label>
          <Select
            id="theme-preset"
            v-model="selectedPreset"
            :options="themePresetOptions"
            optionLabel="name"
            @change="onPresetChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="dark-mode">Dark mode</label>
          <ToggleSwitch
            id="dark-mode"
            v-model="layoutStore.isDark"
            @update:modelValue="onDarkModeChange"
          />
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="nav-position">Nav position</label>
          <Select
            id="nav-position"
            v-model="selectedNavPosition"
            :options="navPositionOptions"
            optionLabel="name"
            @change="onNavPositionChange"
          />
        </div>
        <div
          v-if="showCollapseMode"
          class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
        >
          <label for="collapse-mode">Sidebar mode</label>
          <Select
            id="collapse-mode"
            v-model="selectedCollapseMode"
            :options="collapseModeOptions"
            optionLabel="name"
            @change="onCollapseModeChange"
          />
        </div>
      </div>

      <Divider align="left" type="solid">
        <b>This device</b>
      </Divider>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <label for="device-name">Device name</label>
          <InputText
            id="device-name"
            v-model="sync.deviceName.value"
            class="sm:w-80"
            @blur="sync.saveDeviceName()"
          />
        </div>
        <p class="text-sm text-surface-500">
          Used to identify this device when syncing. Renaming it triggers one
          harmless re-merge on the next sync.
        </p>
      </div>

      <Divider align="left" type="solid">
        <b>Sync status</b>
      </Divider>
      <div class="flex flex-col gap-6">
        <!-- Last sync (this device) -->
        <div class="flex flex-col gap-1">
          <div class="font-medium">Last sync (this device)</div>
          <template v-if="sync.lastKnownRemoteState.value">
            <div class="flex justify-between text-sm">
              <span>When</span>
              <span :title="sync.lastKnownRemoteState.value.uploadedAtUtc">
                {{ formatInstant(sync.lastKnownRemoteState.value.uploadedAtUtc) }}
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Uploaded by</span>
              <span>{{ sync.lastKnownRemoteState.value.device }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.lastKnownRemoteState.value.hash" class="font-mono">
                {{ shortHash(sync.lastKnownRemoteState.value.hash) }}
              </span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">Never synced from this device.</div>
        </div>

        <!-- Current local database -->
        <div class="flex flex-col gap-1">
          <div class="flex justify-between items-center">
            <div class="font-medium">Current local database</div>
            <Button
              label="Recompute"
              severity="secondary"
              size="small"
              text
              @click="sync.recomputeLocalHash()"
            />
          </div>
          <template v-if="sync.localHash.value !== null">
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.localHash.value" class="font-mono">
                {{ shortHash(sync.localHash.value) }}
                <span v-if="localHashMatchesLastSync" class="text-surface-500">
                  (matches last sync)
                </span>
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Computed at</span>
              <span>{{ formatInstant(sync.localHashComputedAt.value?.toISOString()) }}</span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">
            Not available — sync backend not yet registered. Click Recompute after the
            External-sync plan lands.
          </div>
        </div>

        <!-- Last seen remote -->
        <div class="flex flex-col gap-1">
          <div class="font-medium">Last seen remote</div>
          <template v-if="sync.lastFetchedRemoteSnapshot.value">
            <div class="flex justify-between text-sm">
              <span>When</span>
              <span :title="sync.lastFetchedRemoteSnapshot.value.uploadedAtUtc">
                {{ formatInstant(sync.lastFetchedRemoteSnapshot.value.uploadedAtUtc) }}
              </span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Uploaded by</span>
              <span>{{ sync.lastFetchedRemoteSnapshot.value.device }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span>Hash</span>
              <span :title="sync.lastFetchedRemoteSnapshot.value.hash" class="font-mono">
                {{ shortHash(sync.lastFetchedRemoteSnapshot.value.hash) }}
              </span>
            </div>
          </template>
          <div v-else class="text-sm text-surface-500">No remote connection.</div>
        </div>

        <div class="flex flex-col gap-2 mt-2">
          <div class="flex items-center justify-between gap-2">
            <Button
              label="Sync now"
              icon="pi pi-sync"
              :loading="sync.syncing.value"
              :disabled="sync.syncing.value || !backendAvailable"
              @click="sync.syncNow()"
            />
            <span v-if="!backendAvailable" class="text-sm text-surface-500">
              No sync provider configured.
            </span>
          </div>
          <Message
            v-if="sync.lastSyncError.value"
            severity="error"
            :closable="false"
            class="text-sm"
          >
            Sync failed at {{ formatInstant(sync.lastSyncError.value.atUtc) }}:
            {{ sync.lastSyncError.value.message }}
          </Message>
        </div>
      </div>

      <Divider align="left" type="solid">
        <b>Sync provider</b>
      </Divider>
      <div class="flex flex-col gap-6">
        <!-- Active selector -->
        <div class="flex flex-wrap items-center gap-4">
          <span class="font-medium mr-2">Active:</span>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-none"
              value="none"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-none">None</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-supabase"
              value="supabase"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-supabase">Supabase</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-s3"
              value="s3"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-s3">S3-compatible</label>
          </div>
          <div class="flex items-center gap-2">
            <RadioButton
              v-model="sync.providerConfig.value.active"
              inputId="provider-github"
              value="github"
              @change="sync.saveProviderConfig()"
            />
            <label for="provider-github">GitHub</label>
          </div>
        </div>

        <!-- Supabase block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">Supabase</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-url">URL</label>
            <InputText
              id="sb-url"
              v-model="sync.providerConfig.value.supabase.url"
              class="sm:w-80"
              placeholder="https://xxx.supabase.co"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-key">Anon key</label>
            <Password
              inputId="sb-key"
              v-model="sync.providerConfig.value.supabase.anonKey"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="sb-bucket">Storage bucket</label>
            <InputText
              id="sb-bucket"
              v-model="sync.providerConfig.value.supabase.bucket"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex items-end gap-2">
            <Button
              label="Validate"
              :loading="validating.supabase"
              :disabled="!canValidateSupabase"
              @click="onValidateSupabase"
            />
            <span v-if="validateStatus.supabase === 'ok'" class="text-sm text-green-600">
              Connected.
            </span>
            <span v-if="validateStatus.supabase === 'fail'" class="text-sm text-red-600">
              {{ validateMessage.supabase }}
            </span>
          </div>
        </div>

        <!-- S3-compatible block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">S3-compatible (Backblaze B2 / Cloudflare R2)</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-endpoint">Endpoint</label>
            <InputText
              id="s3-endpoint"
              v-model="sync.providerConfig.value.s3.endpoint"
              class="sm:w-80"
              placeholder="https://…"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-region">Region</label>
            <InputText
              id="s3-region"
              v-model="sync.providerConfig.value.s3.region"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-akid">Access key ID</label>
            <InputText
              id="s3-akid"
              v-model="sync.providerConfig.value.s3.accessKeyId"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-sk">Secret key</label>
            <Password
              inputId="s3-sk"
              v-model="sync.providerConfig.value.s3.secretKey"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-bucket">Bucket</label>
            <InputText
              id="s3-bucket"
              v-model="sync.providerConfig.value.s3.bucket"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="s3-key">Object key</label>
            <InputText
              id="s3-key"
              v-model="sync.providerConfig.value.s3.objectKey"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex items-end gap-2">
            <Button
              label="Validate"
              :loading="validating.s3"
              :disabled="!canValidateS3"
              @click="onValidateS3"
            />
            <span v-if="validateStatus.s3 === 'ok'" class="text-sm text-green-600">
              Connected.
            </span>
            <span v-if="validateStatus.s3 === 'fail'" class="text-sm text-red-600">
              {{ validateMessage.s3 }}
            </span>
          </div>
        </div>

        <!-- GitHub block -->
        <div class="flex flex-col gap-2">
          <div class="font-medium">GitHub</div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-repo">Repository</label>
            <InputText
              id="gh-repo"
              v-model="sync.providerConfig.value.github.repo"
              class="sm:w-80"
              placeholder="owner/repo"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-branch">Branch</label>
            <InputText
              id="gh-branch"
              v-model="sync.providerConfig.value.github.branch"
              class="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <label for="gh-token">Token (PAT)</label>
            <Password
              inputId="gh-token"
              v-model="sync.providerConfig.value.github.token"
              :feedback="false"
              toggleMask
              inputClass="sm:w-80"
              @blur="sync.saveProviderConfig()"
            />
          </div>
          <div class="flex items-end gap-2">
            <Button
              label="Validate"
              :loading="validating.github"
              :disabled="!canValidateGitHub"
              @click="onValidateGitHub"
            />
            <span v-if="validateStatus.github === 'ok'" class="text-sm text-green-600">
              Connected.
            </span>
            <span v-if="validateStatus.github === 'fail'" class="text-sm text-red-600">
              {{ validateMessage.github }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </Card>
</template>
