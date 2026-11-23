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
import type { MemoryRuntime } from './runtime.ts';
import type { MemoryTier, MemoryEntry, StoreFile } from './store.ts';
import type { SnapshotFile } from './snapshot.ts';
/** What one tier's restore would touch. */
export interface TierRestoreDiff {
    readonly tier: MemoryTier;
    /** In the snapshot but not on disk now; restore re-adds them. */
    readonly added: readonly MemoryEntry[];
    /** On disk now but not in the snapshot; restore removes them. */
    readonly removed: readonly MemoryEntry[];
    /** Both sides differ; the current card predates the snapshot's capture. */
    readonly modified: readonly MemoryEntry[];
    /** Both sides differ and the current card moved after the snapshot. */
    readonly conflicts: readonly {
        id: string;
        current: MemoryEntry;
        snapshot: MemoryEntry;
    }[];
    /** Identical on both sides. */
    readonly unchanged: number;
}
/** The full preview for one snapshot. */
export interface RestorePlan {
    readonly snapshotId: string;
    readonly snapshotCreatedAt: number;
    readonly tiers: readonly TierRestoreDiff[];
}
/**
 * Diff one snapshot against the current on-disk state.
 *
 * Only tiers the snapshot actually captured are compared; a tier that appears
 * later (or was disabled at snapshot time) is out of scope for this restore.
 */
export declare function diffRestore(snapshot: SnapshotFile, current: Partial<Record<MemoryTier, StoreFile>>): RestorePlan;
/** One confirmed restore step: `tier:id:direction`, direction add|remove|modify. */
export interface RestoreSelection {
    readonly tier: MemoryTier;
    readonly id: string;
    readonly direction: 'add' | 'remove' | 'modify';
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
export declare function applyRestore(runtime: MemoryRuntime, snapshot: SnapshotFile, selections: readonly RestoreSelection[], now?: number): {
    preRestoreId: string;
    touched: {
        tier: MemoryTier;
        added: number;
        removed: number;
        modified: number;
    }[];
};
//# sourceMappingURL=restore.d.ts.map