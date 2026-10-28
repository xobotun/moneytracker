import { expect, vi } from 'vitest'
import type { Database } from '../../db/Database'
import type { RemoteState, SyncOutcome } from '../types'
import type { SyncBackend } from '../SyncBackend'
import { runSync } from '../syncOrchestrator'
import { hashDatabase } from '../hashDatabase'
import { GitHubCsvBackend } from '../GitHubCsvBackend'
import { TagsRepository } from '../../db/repositories/TagsRepository'
import { TagDetailsRepository } from '../../db/repositories/TagDetailsRepository'
import { TransactionsRepository } from '../../db/repositories/TransactionsRepository'
import { AccountsRepository } from '../../db/repositories/AccountsRepository'
import { AppliedRatesRepository } from '../../db/repositories/AppliedRatesRepository'
import { ImagesRepository } from '../../db/repositories/ImagesRepository'
import { FakeGitHubRemote, FakeSyncBackend } from './fakes'
import { newMigratedDb } from './helpers'

// Several devices syncing through one remote with the real orchestrator, so
// every merge tells which side changed a row as the app does: by the device's
// sync base, or by the upload time of its last sync when it has no base. The
// clock is mocked and set by hand before every step.

export const T0 = '2026-05-01T00:00:00.000Z' // the shared data is created
export const C = '2026-05-01T01:00:00.000Z' // every device syncs it
/** `n` minutes after C. */
export const minute = (n: number) => new Date(Date.parse(C) + n * 60_000).toISOString()
export const at = (iso: string) => vi.setSystemTime(new Date(iso))

/**
 * Where the devices sync: `memory` holds the remote as a database clone
 * (FakeSyncBackend); `github` goes through the real GitHubCsvBackend over an
 * in-memory GitHub, so every upload and download is a CSV round trip.
 */
export type BackendKind = 'memory' | 'github'

export interface Device {
  name: string
  db: Database
  tags: TagsRepository
  details: TagDetailsRepository
  transactions: TransactionsRepository
  accounts: AccountsRepository
  rates: AppliedRatesRepository
  images: ImagesRepository
  sync(): Promise<SyncOutcome>
}

export interface World {
  devices: Device[]
  close(): Promise<void>
}

/**
 * Devices named `names`, each with its own database and last-known remote
 * state. `wrap` may stand between a device and its backend (to inject a race).
 */
export async function openWorld(
  names: string[],
  kind: BackendKind = 'memory',
  wrap: (backend: SyncBackend, device: string) => SyncBackend = (backend) => backend,
): Promise<World> {
  vi.useFakeTimers({ toFake: ['Date'] })
  const memory = new FakeSyncBackend()
  const github = new FakeGitHubRemote()
  const backendFor = (): SyncBackend =>
    kind === 'memory'
      ? memory
      : // One instance per device: it keeps the snapshot its getMetadata() saw.
        new GitHubCsvBackend(
          github.transport({ repo: 'me/mt', branch: 'main', token: 't', path: '' }),
        )

  const devices: Device[] = []
  for (const name of names) {
    const db = await newMigratedDb()
    const backend = wrap(backendFor(), name)
    let lastKnown: RemoteState | null = null
    devices.push({
      name,
      db,
      tags: new TagsRepository(db),
      details: new TagDetailsRepository(db),
      transactions: new TransactionsRepository(db),
      accounts: new AccountsRepository(db),
      rates: new AppliedRatesRepository(db),
      images: new ImagesRepository(db),
      sync: () =>
        runSync(db, {
          backend,
          deviceName: name,
          now: () => new Date(),
          migrate: async () => {},
          loadLastKnown: () => lastKnown,
          saveLastKnown: (state) => {
            lastKnown = state
          },
          sleep: async () => {},
        }),
    })
  }
  return {
    devices,
    async close() {
      vi.useRealTimers()
      for (const device of devices) await device.db.close()
      await memory.close()
    },
  }
}

/** Devices A and B. */
export async function openPair(
  kind: BackendKind = 'memory',
): Promise<World & { devices: [Device, Device] }> {
  return (await openWorld(['A', 'B'], kind)) as World & { devices: [Device, Device] }
}

/** Devices A, B and C. */
export async function openTrio(
  kind: BackendKind = 'memory',
): Promise<World & { devices: [Device, Device, Device] }> {
  return (await openWorld(['A', 'B', 'C'], kind)) as World & {
    devices: [Device, Device, Device]
  }
}

/**
 * The first device creates the shared data at T0; at C every device has
 * synced it (the first uploads, the others merge, then all but the last find
 * nothing to do), so every device's base is the state at C, and its merge
 * cutoff is C.
 */
export async function start(world: World, seed: (device: Device) => Promise<void>): Promise<void> {
  const [first, ...rest] = world.devices
  at(T0)
  await seed(first!)
  at(C)
  expect((await first!.sync()).decision).toBe('first-sync-upload')
  for (const device of rest) expect((await device.sync()).decision).toBe('merge')
  for (const device of world.devices.slice(0, -1)) {
    expect((await device.sync()).decision).toBe('none')
  }
}

/** Same rows on every device, and each device's next sync (at `time`) finds nothing to do. */
export async function expectConverged(devices: Device[], time: string): Promise<void> {
  const hashes = await Promise.all(devices.map((d) => hashDatabase(d.db)))
  expect(new Set(hashes).size, `hashes of ${devices.map((d) => d.name).join(', ')}`).toBe(1)
  at(time)
  for (const device of devices) {
    expect((await device.sync()).decision, `${device.name}'s next sync`).toBe('none')
  }
}

/**
 * Lets the devices sync in turn, one minute apart from `minute(from)`, until
 * a whole round finds nothing to do (at most `maxRounds` rounds), then checks
 * they hold the same rows. Returns the minute after the last sync, for the
 * scenario to go on from.
 */
export async function settle(devices: Device[], from: number, maxRounds = 4): Promise<number> {
  let step = from
  for (let round = 1; round <= maxRounds; round++) {
    let quiet = true
    for (const device of devices) {
      at(minute(step++))
      if ((await device.sync()).decision !== 'none') quiet = false
    }
    if (quiet) {
      const hashes = await Promise.all(devices.map((d) => hashDatabase(d.db)))
      expect(new Set(hashes).size).toBe(1)
      return step
    }
  }
  throw new Error(`The devices did not settle within ${maxRounds} rounds`)
}
