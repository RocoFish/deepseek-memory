/**
 * Snapshots: named, restorable points-in-time of the whole memory library.
 *
 * Three properties are deliberate:
 *
 * 1. **A snapshot captures on-disk truth.** Creation refreshes the runtime
 *    cache and reads the files from disk, so it can never immortalize a stale
 *    in-memory state that a crashed session would have lost anyway.
 * 2. **Snapshots live outside the tiers they capture.** The project tier is
 *    designed to be committed to a repository; burying backups in it would
 *    pollute the repo and leak personal-tier data into a shared tree. The
 *    snapshot directory therefore sits in the user tier, with the project
 *    tier as fallback for deployments that have no user tier.
 * 3. **Retention is per-kind.** Pre-operation snapshots are frequent and
 *    short-lived; dailies cover slow drift; weeklies cover late discovery.
 *    Each kind keeps its own bound so one chatty kind cannot evict the rest.
 *
 * @module deepseek-memory/snapshot
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryRuntime } from './runtime.ts'
import type { MemoryTier, StoreFile } from './store.ts'
import { MemoryError, MemoryStore } from './store.ts'

/** Directory (inside the auxiliary tier) holding snapshots. */
export const SNAPSHOT_DIR = 'snapshots'

/** Current snapshot file format. */
export const SNAPSHOT_FORMAT = 1

/** Why a snapshot exists. */
export type SnapshotKind = 'pre-op' | 'pre-restore' | 'daily' | 'weekly' | 'manual'

/**
 * How many snapshots of each kind are kept; oldest first out. `manual` keeps
 * everything — an explicit human request is not pruned by policy.
 */
export const SNAPSHOT_RETENTION: Readonly<Record<SnapshotKind, number>> = {
  'pre-op': 20,
  'pre-restore': 10,
  daily: 7,
  weekly: 4,
  manual: Number.POSITIVE_INFINITY,
}

/** One snapshot's payload: both tiers' store files, whole. */
export interface SnapshotFile {
  readonly snapshotVersion: number
  readonly id: string
  readonly kind: SnapshotKind
  /** What caused it, e.g. `auto-load`, `tool`, `memory_arbitrate:adopt`. */
  readonly trigger: string
  /** Creation time, epoch milliseconds. */
  readonly createdAt: number
  /** Whole store files, keyed by tier; a disabled tier is simply absent. */
  readonly tiers: Partial<Record<MemoryTier, StoreFile>>
}

/** One snapshot's identity, as listed. */
export interface SnapshotMeta {
  readonly id: string
  readonly kind: SnapshotKind
  readonly trigger: string
  readonly createdAt: number
  /** Absolute path of the snapshot file. */
  readonly file: string
}

/** Snapshot ids are file names; anything else is a path-traversal attempt. */
const SNAPSHOT_ID_PATTERN = /^[a-z]+-[0-9T].*[0-9a-f]{8}$/

/**
 * The directory snapshots live in: the user tier's directory when the user
 * tier exists, otherwise the project tier's. Both capture targets stay
 * outside this directory, so a snapshot can never recursively contain itself.
 */
export function snapshotBaseDir(runtime: MemoryRuntime): string {
  const tiers = runtime.enabledTiers()
  const host = tiers.includes('user') ? 'user' : tiers.includes('project') ? 'project' : undefined
  if (host === undefined) {
    throw new MemoryError(
      'snapshots need somewhere to live, but no memory tier is enabled in this deployment.',
      'MEMORY_NO_TIER',
    )
  }
  return runtime.tierDir(host)
}

/** The snapshots directory for one deployment; creation is not implied. */
function snapshotDir(runtime: MemoryRuntime): string {
  return join(snapshotBaseDir(runtime), SNAPSHOT_DIR)
}

/** Read the current on-disk store file for one tier, when it exists and parses. */
function readStoreFile(file: string): StoreFile | undefined {
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreFile
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.entries)) {
    throw new MemoryError(`memory store at ${file} has no entries array`, 'MEMORY_STORE_MALFORMED')
  }
  return parsed
}

/** Every enabled tier's on-disk store file, keyed by tier. */
export function readCurrentStores(runtime: MemoryRuntime): Partial<Record<MemoryTier, StoreFile>> {
  runtime.refresh()
  const current: Partial<Record<MemoryTier, StoreFile>> = {}
  for (const row of runtime.describe()) {
    if (!row.readable) continue
    const file = readStoreFile(row.file)
    if (file !== undefined) current[row.tier] = file
  }
  return current
}

/**
 * Create one snapshot of the whole library as it exists on disk right now.
 *
 * The runtime cache is dropped first, so the captured state is exactly what a
 * restart would load. A deployment with nothing stored yet is refused rather
 * than snapshotted empty — restoring an empty snapshot would look like data
 * loss and be hard to distinguish from the real thing.
 */
export function createSnapshot(
  runtime: MemoryRuntime,
  kind: SnapshotKind,
  trigger: string,
  now: number = Date.now(),
): SnapshotMeta {
  const tiers = readCurrentStores(runtime)
  if (Object.keys(tiers).length === 0) {
    throw new MemoryError('there is no memory store on disk yet, so there is nothing to snapshot.', 'MEMORY_NOTHING_TO_SNAPSHOT')
  }
  const id = `${kind}-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const payload: SnapshotFile = { snapshotVersion: SNAPSHOT_FORMAT, id, kind, trigger, createdAt: now, tiers }
  const dir = snapshotDir(runtime)
  // Snapshots hold whole tiers including personal data, so the directory is as
  // private as the store and history directories (0o700), not default umask.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${id}.json`)
  // Same write-then-rename discipline as the store itself.
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temp, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* nothing left to clean */ }
    throw error
  }
  pruneSnapshots(runtime)
  return { id, kind, trigger, createdAt: now, file }
}

/** Every snapshot, newest first. A missing directory is an empty list, not an error. */
export function listSnapshots(runtime: MemoryRuntime): SnapshotMeta[] {
  const dir = snapshotDir(runtime)
  if (!existsSync(dir)) return []
  const metas: SnapshotMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<SnapshotFile>
      if (typeof parsed.id !== 'string' || typeof parsed.kind !== 'string' || typeof parsed.createdAt !== 'number') continue
      metas.push({
        id: parsed.id,
        kind: parsed.kind as SnapshotKind,
        trigger: typeof parsed.trigger === 'string' ? parsed.trigger : 'unknown',
        createdAt: parsed.createdAt,
        file: join(dir, name),
      })
    } catch { /* a half-written snapshot is skipped, not fatal */ }
  }
  metas.sort((left, right) => right.createdAt - left.createdAt)
  return metas
}

/** Load and validate one snapshot by id. */
export function loadSnapshot(runtime: MemoryRuntime, id: string): SnapshotFile {
  if (!SNAPSHOT_ID_PATTERN.test(id)) {
    throw new MemoryError(`"${id}" is not a snapshot id. Call memory_snapshot with action "list" to see the ids.`, 'MEMORY_SNAPSHOT_NOT_FOUND')
  }
  const file = join(snapshotDir(runtime), `${id}.json`)
  if (!existsSync(file)) {
    throw new MemoryError(`there is no snapshot with id ${id}. Call memory_snapshot with action "list" to see the ids.`, 'MEMORY_SNAPSHOT_NOT_FOUND')
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SnapshotFile>
  if (parsed.snapshotVersion !== SNAPSHOT_FORMAT || typeof parsed.id !== 'string' || parsed.id !== id
    || typeof parsed.createdAt !== 'number' || typeof parsed.tiers !== 'object' || parsed.tiers === null) {
    throw new MemoryError(`snapshot at ${file} is malformed or uses an unsupported format.`, 'MEMORY_SNAPSHOT_MALFORMED')
  }
  // Shell validation is not entry validation. A snapshot file can arrive
  // hand-edited, corrupted, or from a shared project tier, and restore feeds
  // its entries straight into the store through the byte-preserving restore
  // path — so every tier file must pass the same per-entry normalization and
  // bounds the live store enforces on load, before any selection is applied.
  // Entries that survive come back normalized; a file the store would refuse
  // is refused here, with the store's own diagnostic.
  const tiers = parsed.tiers as Record<string, unknown>
  for (const [tierName, tierFile] of Object.entries(tiers)) {
    if (tierName !== 'user' && tierName !== 'project') {
      throw new MemoryError(`snapshot at ${file} carries an unknown tier "${tierName}".`, 'MEMORY_SNAPSHOT_MALFORMED')
    }
    if (tierFile === null || typeof tierFile !== 'object' || !Array.isArray((tierFile as StoreFile).entries)) {
      throw new MemoryError(`snapshot at ${file} holds no entries array for its ${tierName} tier.`, 'MEMORY_SNAPSHOT_MALFORMED')
    }
    const store = new MemoryStore(tierName, runtime.storeLimits())
    store.load(tierFile, `snapshot ${id} (${tierName} tier)`)
    tiers[tierName] = { ...(tierFile as StoreFile), entries: store.entries() }
  }
  return parsed as SnapshotFile
}

/**
 * Enforce per-kind retention, oldest first. Failures are swallowed: pruning
 * is hygiene, and losing hygiene must never lose the snapshots themselves.
 */
export function pruneSnapshots(runtime: MemoryRuntime): void {
  const metas = listSnapshots(runtime)
  const byKind = new Map<SnapshotKind, SnapshotMeta[]>()
  for (const meta of metas) {
    const bucket = byKind.get(meta.kind)
    if (bucket === undefined) byKind.set(meta.kind, [meta])
    else bucket.push(meta)
  }
  for (const [kind, bucket] of byKind) {
    const keep = SNAPSHOT_RETENTION[kind]
    if (!Number.isFinite(keep) || bucket.length <= keep) continue
    for (const meta of bucket.slice(0, bucket.length - keep)) {
      try { rmSync(meta.file, { force: true }) } catch { /* already gone */ }
    }
  }
}

/**
 * The slow-drift safety net: a daily snapshot when none exists today, a
 * weekly when none exists this ISO week.
 *
 * Runs at plugin load, so "daily" means "the first session of the day" — the
 * store changes so little that finer timing buys nothing. Failures are the
 * caller's to log; a snapshot hiccup must never stop the plugin from loading.
 */
export function maybeAutoSnapshot(runtime: MemoryRuntime, now: number = Date.now()): SnapshotMeta[] {
  const created: SnapshotMeta[] = []
  const metas = listSnapshots(runtime)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(dayStart)
  // ISO weeks start on Monday.
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))
  const latestDaily = metas.filter(meta => meta.kind === 'daily')[0]
  const latestWeekly = metas.filter(meta => meta.kind === 'weekly')[0]
  if (latestDaily === undefined || latestDaily.createdAt < dayStart.getTime()) {
    created.push(createSnapshot(runtime, 'daily', 'auto-load', now))
  }
  if (latestWeekly === undefined || latestWeekly.createdAt < weekStart.getTime()) {
    created.push(createSnapshot(runtime, 'weekly', 'auto-load', now))
  }
  return created
}
