/**
 * The memory store: two tiers of small, explicit, plain-text facts.
 *
 * Design stance, taken from how frontier assistants actually do this (Kimi's
 * Memory Space is the reference): memory is deliberately **small and curated**,
 * not a transcript index. The bound is what makes retrieval unnecessary — if the
 * whole store fits in a system-prompt section, there is no ranking problem, no
 * embedding service, and no stale-snapshot problem.
 *
 * Two tiers:
 * - `user` — who the person is: stable preferences, working style, standing
 *   instructions. Lives in `$DSH_HOME/memory/`.
 * - `project` — conventions and decisions that belong to one directory tree.
 *   Lives in `<cwd>/.dsh-memory/`, so it can be committed and shared.
 *
 * The stored file is the source of truth and stays human-readable and
 * hand-editable. Every mutation is atomic (write-then-rename) and keeps the
 * previous revision in `history/`, because a memory store that can be corrupted
 * by an interrupted write is worse than no memory at all.
 *
 * @module deepseek-memory/store
 */
/** Hard ceiling on entry count per tier. Small on purpose; see the module doc. */
export declare const DEFAULT_MAX_ENTRIES = 50;
/** Hard ceiling on one entry's length, in Unicode code points. */
export declare const DEFAULT_MAX_ENTRY_CHARS = 500;
/** Current on-disk format. A newer file is refused rather than misread. */
export declare const STORE_FORMAT = 1;
/** Which tier a store belongs to. */
export type MemoryTier = 'user' | 'project';
/** One curated memory entry. */
export interface MemoryEntry {
    /** Short stable id, derived from the text so re-adding the same fact is a no-op. */
    readonly id: string;
    /** The remembered fact, one self-contained sentence or two. */
    readonly text: string;
    /** Free-form labels for the injector's section ordering and manual browsing. */
    readonly tags: readonly string[];
    /** Creation time, epoch milliseconds. */
    readonly createdAt: number;
    /** Last modification time, epoch milliseconds. */
    readonly updatedAt: number;
    /** How the entry last changed, for audit and for the UI. */
    readonly origin: 'user' | 'consolidator';
    /** The session that produced the entry, when known. */
    readonly sourceSession?: string;
}
/** The serialized store file. */
export interface StoreFile {
    readonly format: number;
    readonly tier: MemoryTier;
    /** Monotonic revision, bumped by every committed mutation. */
    readonly revision: number;
    readonly updatedAt: number;
    readonly entries: readonly MemoryEntry[];
}
/** A refusal the caller is expected to surface to the model verbatim. */
export declare class MemoryError extends Error {
    /** Stable machine-readable discriminant. */
    readonly code: string;
    /**
     * @param message - teaching text the model can act on.
     * @param code - stable machine-readable discriminant.
     */
    constructor(message: string, code: string);
}
/** Trim, collapse whitespace runs, and drop framing the model already understands. */
export declare function normalizeEntryText(value: string): string;
/** Unicode code-point length, so the cap means the same thing for CJK and Latin. */
export declare function codePointLength(value: string): number;
/**
 * Derive an entry id from its text.
 *
 * Deriving rather than randomizing gives idempotent adds for free: the same fact
 * expressed the same way lands on the same id, so "remember X" twice does not
 * grow the store, and a conflicting add is detected instead of duplicated.
 * @param text - normalized entry text.
 */
export declare function entryId(text: string): string;
/** One in-memory view of a store file, with the invariants enforced in code. */
export declare class MemoryStore {
    #private;
    /** Which tier this store represents. */
    readonly tier: MemoryTier;
    /**
     * @param tier - which tier this store represents.
     * @param limits - the configured ceilings.
     */
    constructor(tier: MemoryTier, limits: {
        maxEntries: number;
        maxEntryChars: number;
    });
    /** Where this state came from, for diagnostics: a path, or `empty`. */
    get source(): string;
    /** Current committed revision. */
    get revision(): number;
    /** When this store was last mutated, epoch milliseconds, or 0 for a fresh store. */
    get updatedAt(): number;
    /** Number of live entries. */
    get size(): number;
    /** A detached copy of every entry, newest update first. */
    entries(): MemoryEntry[];
    /**
     * Load a parsed store file.
     *
     * A file written by a newer format is refused instead of guessed at, because
     * silently dropping fields the running build does not know about is how a
     * memory store loses data without anyone noticing.
     * @param raw - parsed JSON, however malformed.
     * @param source - where it came from, for diagnostics.
     */
    load(raw: unknown, source: string): void;
    /** The value to serialize. */
    toFile(now: number): StoreFile;
    /**
     * Add one entry.
     * @returns the stored entry, plus whether it was newly created.
     * @throws {MemoryError} when the text is invalid, duplicates an existing entry, or the store is full.
     */
    add(input: {
        text: string;
        tags?: readonly string[];
        origin: MemoryEntry['origin'];
        sourceSession?: string;
        now: number;
    }): {
        entry: MemoryEntry;
        created: boolean;
    };
    /**
     * Replace one entry's text and tags, keeping its identity and creation time.
     * @throws {MemoryError} when the id is unknown or the replacement is invalid.
     */
    update(input: {
        id: string;
        text?: string;
        tags?: readonly string[];
        origin: MemoryEntry['origin'];
        now: number;
    }): MemoryEntry;
    /**
     * Remove one entry.
     * @throws {MemoryError} when the id is unknown.
     */
    remove(id: string, now: number): MemoryEntry;
    /** List entries, optionally narrowed by a literal case-insensitive substring. */
    list(query?: string): MemoryEntry[];
}
//# sourceMappingURL=store.d.ts.map