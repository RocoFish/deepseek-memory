/**
 * Restore: see exactly what a snapshot would change, then change only what
 * was confirmed — never the other way around.
 *
 * The four-step contract, fixed before any code was written:
 *
 * 1. pick a snapshot;
 * 2. get a **preview** — the diff between the snapshot and the current
 *    library, in four buckets;
 * 3. confirm item by item or in batch;
 * 4. only then: back the current library up as `pre-restore`, and write.
 *
 * The preview is what makes restore safe, so the four buckets are defined by
 * what they cost you:
 *
 * - `added` — in the snapshot, gone now. Restoring re-adds; riskless.
 * - `removed` — created after the snapshot. Restoring deletes; riskless for
 *   the snapshot's view, worth a glance for yours.
 * - `modified` — both sides have the card, it changed, and the current side
 *   has not moved since the snapshot. The snapshot's version is simply newer
 *   truth.
 * - `conflicts` — both sides have the card, it changed, **and the current
 *   card was edited after the snapshot was taken**. Overwriting it would
 *   destroy work the snapshot never saw; these are apply-only-if-explicitly
 *   picked, one by one.
 *
 * @module deepseek-memory/restore
 */
import type { MemoryRuntime } from './runtime.ts'
import type { MemoryTier, MemoryEntry, StoreFile } from './store.ts'
import { MemoryError } from './store.ts'
import type { SnapshotFile } from './snapshot.ts'
import { createSnapshot } from './snapshot.ts'

/** What one tier's restore would touch. */
export interface TierRestoreDiff {
  readonly tier: MemoryTier
  /** In the snapshot but not on disk now; restore re-adds them. */
  readonly added: readonly MemoryEntry[]
  /** On disk now but not in the snapshot; restore removes them. */
  readonly removed: readonly MemoryEntry[]
  /** Both sides differ; the current card predates the snapshot's capture. */
  readonly modified: readonly MemoryEntry[]
  /** Both sides differ and the current card moved after the snapshot. */
  readonly conflicts: readonly { id: string; current: MemoryEntry; snapshot: MemoryEntry }[]
  /** Identical on both sides. */
  readonly unchanged: number
}

/** The full preview for one snapshot. */
export interface RestorePlan {
  readonly snapshotId: string
  readonly snapshotCreatedAt: number
  readonly tiers: readonly TierRestoreDiff[]
}

/** Which parts of a card matter for "did it change". */
function cardDiffers(left: MemoryEntry, right: MemoryEntry): boolean {
  return left.text !== right.text
    || left.status !== right.status
    || left.confidence !== right.confidence
    || left.scope !== right.scope
    || left.subject !== right.subject
    || left.key !== right.key
    || left.tags.length !== right.tags.length
    || left.tags.some((tag, index) => tag !== right.tags[index])
    || left.supersedes.length !== right.supersedes.length
    || left.supersedes.some((id, index) => id !== right.supersedes[index])
}

/**
 * Diff one snapshot against the current on-disk state.
 *
 * Only tiers the snapshot actually captured are compared; a tier that appears
 * later (or was disabled at snapshot time) is out of scope for this restore.
 */
export function diffRestore(snapshot: SnapshotFile, current: Partial<Record<MemoryTier, StoreFile>>): RestorePlan {
  const tiers: TierRestoreDiff[] = []
  for (const [tierName, snapshotStore] of Object.entries(snapshot.tiers) as [MemoryTier, StoreFile][]) {
    const tier = tierName
    const currentStore = current[tier]
    const snapshotById = new Map(snapshotStore.entries.map(entry => [entry.id, entry]))
    const currentById = new Map((currentStore?.entries ?? []).map(entry => [entry.id, entry]))
    const added: MemoryEntry[] = []
    const removed: MemoryEntry[] = []
    const modified: MemoryEntry[] = []
    const conflicts: { id: string; current: MemoryEntry; snapshot: MemoryEntry }[] = []
    let unchanged = 0
    for (const entry of snapshotStore.entries) {
      const live = currentById.get(entry.id)
      if (live === undefined) {
        added.push(entry)
        continue
      }
      if (!cardDiffers(entry, live)) {
        unchanged += 1
        continue
      }
      // The current card moved after the snapshot was taken: its edits are
      // work the snapshot never saw, so overwriting it is a conflict, not a
      // modification.
      if (live.updatedAt > snapshot.createdAt) {
        conflicts.push({ id: entry.id, current: live, snapshot: entry })
      } else {
        modified.push(entry)
      }
    }
    for (const entry of currentStore?.entries ?? []) {
      if (!snapshotById.has(entry.id)) removed.push(entry)
    }
    tiers.push({ tier, added, removed, modified, conflicts, unchanged })
  }
  return { snapshotId: snapshot.id, snapshotCreatedAt: snapshot.createdAt, tiers }
}

/** One confirmed restore step: `tier:id:direction`, direction add|remove|modify. */
export interface RestoreSelection {
  readonly tier: MemoryTier
  readonly id: string
  readonly direction: 'add' | 'remove' | 'modify'
}

/**
 * Apply confirmed selections from one snapshot.
 *
 * Order is the contract: the current library is backed up as `pre-restore`
 * **before** any mutation lands, every mutation goes through the store's
 * revisioned write paths, and only tiers that received a confirmed selection
 * are committed. Unconfirmed entries — conflicts above all — are untouched.
 *
 * @returns what changed, and the pre-restore backup id.
 */
export function applyRestore(
  runtime: MemoryRuntime,
  snapshot: SnapshotFile,
  selections: readonly RestoreSelection[],
  now: number = Date.now(),
): { preRestoreId: string; touched: { tier: MemoryTier; added: number; removed: number; modified: number }[] } {
  if (selections.length === 0) {
    throw new MemoryError(
      'restore needs at least one confirmed selection; run memory_restore with action "preview" first and pick the entries to apply.',
      'MEMORY_RESTORE_NO_SELECTION',
    )
  }
  const byTier = new Map<MemoryTier, RestoreSelection[]>()
  for (const selection of selections) {
    const bucket = byTier.get(selection.tier)
    if (bucket === undefined) byTier.set(selection.tier, [selection])
    else bucket.push(selection)
  }
  // Backup first. This refreshes the runtime, so the stores loaded below are
  // the on-disk truth the diff was computed against.
  const backup = createSnapshot(runtime, 'pre-restore', `restore:${snapshot.id}`, now)
  runtime.refresh()
  const touched: { tier: MemoryTier; added: number; removed: number; modified: number }[] = []
  for (const [tier, tierSelections] of byTier) {
    const store = runtime.store(tier)
    const snapshotEntries = new Map((snapshot.tiers[tier]?.entries ?? []).map(entry => [entry.id, entry]))
    let added = 0
    let removed = 0
    let modified = 0
    for (const selection of tierSelections) {
      if (selection.direction === 'remove') {
        store.remove(selection.id, now)
        removed += 1
        continue
      }
      const entry = snapshotEntries.get(selection.id)
      if (entry === undefined) {
        throw new MemoryError(
          `snapshot ${snapshot.id} holds no ${selection.id} in the ${tier} tier; refusing to restore an entry it never captured.`,
          'MEMORY_RESTORE_NOT_IN_SNAPSHOT',
        )
      }
      store.upsertRestored(entry)
      if (selection.direction === 'add') added += 1
      else modified += 1
    }
    runtime.commit(tier, store)
    touched.push({ tier, added, removed, modified })
  }
  return { preRestoreId: backup.id, touched }
}
