import type { MemoryRuntime } from './runtime.ts';
import type { MemoryTier, StoreFile } from './store.ts';
/** Directory (inside the auxiliary tier) holding snapshots. */
export declare const SNAPSHOT_DIR = "snapshots";
/** Current snapshot file format. */
export declare const SNAPSHOT_FORMAT = 1;
/** Why a snapshot exists. */
export type SnapshotKind = 'pre-op' | 'pre-restore' | 'daily' | 'weekly' | 'manual';
/**
 * How many snapshots of each kind are kept; oldest first out. `manual` keeps
 * everything — an explicit human request is not pruned by policy.
 */
export declare const SNAPSHOT_RETENTION: Readonly<Record<SnapshotKind, number>>;
/** One snapshot's payload: both tiers' store files, whole. */
export interface SnapshotFile {
    readonly snapshotVersion: number;
    readonly id: string;
    readonly kind: SnapshotKind;
    /** What caused it, e.g. `auto-load`, `tool`, `memory_arbitrate:adopt`. */
    readonly trigger: string;
    /** Creation time, epoch milliseconds. */
    readonly createdAt: number;
    /** Whole store files, keyed by tier; a disabled tier is simply absent. */
    readonly tiers: Partial<Record<MemoryTier, StoreFile>>;
}
/** One snapshot's identity, as listed. */
export interface SnapshotMeta {
    readonly id: string;
    readonly kind: SnapshotKind;
    readonly trigger: string;
    readonly createdAt: number;
    /** Absolute path of the snapshot file. */
    readonly file: string;
}
/**
 * The directory snapshots live in: the user tier's directory when the user
 * tier exists, otherwise the project tier's. Both capture targets stay
 * outside this directory, so a snapshot can never recursively contain itself.
 */
export declare function snapshotBaseDir(runtime: MemoryRuntime): string;
/** Every enabled tier's on-disk store file, keyed by tier. */
export declare function readCurrentStores(runtime: MemoryRuntime): Partial<Record<MemoryTier, StoreFile>>;
/**
 * Create one snapshot of the whole library as it exists on disk right now.
 *
 * The runtime cache is dropped first, so the captured state is exactly what a
 * restart would load. A deployment with nothing stored yet is refused rather
 * than snapshotted empty — restoring an empty snapshot would look like data
 * loss and be hard to distinguish from the real thing.
 */
export declare function createSnapshot(runtime: MemoryRuntime, kind: SnapshotKind, trigger: string, now?: number): SnapshotMeta;
/** Every snapshot, newest first. A missing directory is an empty list, not an error. */
export declare function listSnapshots(runtime: MemoryRuntime): SnapshotMeta[];
/** Load and validate one snapshot by id. */
export declare function loadSnapshot(runtime: MemoryRuntime, id: string): SnapshotFile;
/**
 * Enforce per-kind retention, oldest first. Failures are swallowed: pruning
 * is hygiene, and losing hygiene must never lose the snapshots themselves.
 */
export declare function pruneSnapshots(runtime: MemoryRuntime): void;
/**
 * The slow-drift safety net: a daily snapshot when none exists today, a
 * weekly when none exists this ISO week.
 *
 * Runs at plugin load, so "daily" means "the first session of the day" — the
 * store changes so little that finer timing buys nothing. Failures are the
 * caller's to log; a snapshot hiccup must never stop the plugin from loading.
 */
export declare function maybeAutoSnapshot(runtime: MemoryRuntime, now?: number): SnapshotMeta[];
