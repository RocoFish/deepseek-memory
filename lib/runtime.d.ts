import type { MemoryConfig } from './config.ts';
import { MemoryStore, type MemoryEntry, type MemoryTier } from './store.ts';
/** Directory (under `$DSH_HOME`) holding the user tier. */
export declare const USER_MEMORY_DIR = "memory";
/** Directory (under the project root) holding the project tier. */
export declare const PROJECT_MEMORY_DIR = ".dsh-memory";
/** The store file name inside a tier directory. */
export declare const STORE_FILE = "memory.json";
/** Where previous revisions are kept inside a tier directory. */
export declare const HISTORY_DIR = "history";
/** One resolved store location. */
export interface TierLocation {
    readonly tier: MemoryTier;
    readonly dir: string;
    readonly file: string;
    /** Whether the tier directory already exists; creation is not implied by reading. */
    readonly existed: boolean;
}
/** Outcome of one committed mutation, for logs and for the tool result. */
export interface CommitResult {
    /** Revision number after the commit. */
    readonly revision: number;
    /** Previous-revision backup path, when one was written. */
    readonly historyPath?: string;
}
/**
 * Owns both tiers' files and every mutation to them.
 *
 * Reads are cached per tier for the life of the plugin: the files are small, and
 * re-reading them on every prompt assembly would put filesystem work on the
 * request path. The cache is refreshed at the start of each consolidation and
 * whenever a tool mutates, so external edits become visible at those points.
 */
export declare class MemoryRuntime {
    #private;
    /**
     * @param config - validated plugin configuration.
     * @param dshHome - the resolved harness home, or undefined to disable the user tier.
     * @param cwd - resolves the session project directory; null/undefined disables the project tier. A plain string is accepted for callers with a fixed directory.
     * @param now - clock injection, so tests are deterministic.
     */
    constructor(config: MemoryConfig, dshHome: string | undefined, cwd: (() => string | null | undefined) | string | null | undefined, now?: () => number);
    /** Tiers that are enabled and have a usable location. */
    enabledTiers(): MemoryTier[];
    /** The store for one tier, loaded from disk on first use. */
    store(tier: MemoryTier): MemoryStore;
    /** Every enabled tier's store, in injection priority order. */
    stores(): {
        tier: MemoryTier;
        store: MemoryStore;
    }[];
    /** Drop the cache so the next read observes on-disk edits. */
    refresh(): void;
    /**
     * Atomically commit one tier's current state, keeping the previous revision.
     *
     * Two refusal guards, both cheaper than the failures they prevent:
     *
     * - `expected` — the exact store object the caller mutated. If the runtime's
     *   cache was dropped (a `refresh()`) between the caller's mutation and this
     *   commit, the mutations were made to a store the runtime no longer owns, and
     *   persisting here would silently resurrect stale state. Refuse instead.
     * - disk revision — if the file on disk was committed by another process since
     *   this store was loaded, persisting would overwrite entries this process
     *   never saw (a lost update). Refuse instead.
     *
     * Both refusals drop the tier's cached copy so the next read observes the
     * on-disk truth, and throw a {@link MemoryError} whose message the model (or a
     * retry loop) can act on.
     * @param tier - which store to persist.
     * @param expected - the store object the caller mutated, when the caller holds one.
     */
    commit(tier: MemoryTier, expected?: MemoryStore): CommitResult | undefined;
    /** Convenience: the entry list a tool should show for one tier. */
    list(tier: MemoryTier, query?: string): MemoryEntry[];
    /** Diagnose where each tier lives, for `memory_status` and for logs. */
    describe(): {
        tier: MemoryTier;
        file: string;
        dir: string;
        entries: number;
        revision: number;
        readable: boolean;
    }[];
}
/** The directory a tier owns, without touching the filesystem. */
export declare function tierDirFor(tier: MemoryTier, dshHome: string | undefined, cwd: string | null | undefined): string;
//# sourceMappingURL=runtime.d.ts.map