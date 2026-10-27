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
export const DEFAULT_MAX_ENTRIES = 50;
/** Hard ceiling on one entry's length, in Unicode code points. */
export const DEFAULT_MAX_ENTRY_CHARS = 500;
/** Hard ceiling on how many tags one entry may carry. */
export const MAX_TAGS_PER_ENTRY = 32;
/** Hard ceiling on one tag's length, in Unicode code points. */
export const MAX_TAG_CHARS = 64;
/** Current on-disk format. A newer file is refused rather than misread. */
export const STORE_FORMAT = 1;
/** A refusal the caller is expected to surface to the model verbatim. */
export class MemoryError extends Error {
    /** Stable machine-readable discriminant. */
    code;
    /**
     * @param message - teaching text the model can act on.
     * @param code - stable machine-readable discriminant.
     */
    constructor(message, code) {
        super(message);
        this.name = 'MemoryError';
        this.code = code;
    }
}
/**
 * Trim, collapse whitespace runs, and drop framing the model already
 * understands — including framing that is *ours*, so a stored entry cannot
 * forge the prompt wrapper and smuggle text out of the untrusted-data block.
 */
export function normalizeEntryText(value) {
    return value
        .replace(/<\/?system-reminder>/gi, ' ')
        .replace(/<\/?untrusted-data>/gi, ' ')
        .replace(/[ \t ]+/g, ' ')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
}
/** Unicode code-point length, so the cap means the same thing for CJK and Latin. */
export function codePointLength(value) {
    return [...value].length;
}
/**
 * Normalize and bound one entry's tags.
 *
 * The same rule runs on the write path and on load, so a hand-edited file faces
 * exactly the invariants the store itself enforces.
 * @param tags - raw tag strings.
 * @param source - what is being validated, for the error message.
 * @throws {MemoryError} when there are too many tags or one tag is too long.
 */
function validateTags(tags, source) {
    if (tags.length > MAX_TAGS_PER_ENTRY) {
        throw new MemoryError(`${source} carries ${tags.length} tags on one entry, above the maximum of ${MAX_TAGS_PER_ENTRY}. Remove some tags and try again.`, 'MEMORY_TAGS_INVALID');
    }
    const cleaned = [];
    for (const tag of tags) {
        const trimmed = tag.trim();
        if (trimmed === '')
            continue;
        if (codePointLength(trimmed) > MAX_TAG_CHARS) {
            throw new MemoryError(`${source} carries a tag of ${codePointLength(trimmed)} characters, above the maximum of ${MAX_TAG_CHARS}. Shorten the tag and try again.`, 'MEMORY_TAGS_INVALID');
        }
        cleaned.push(trimmed);
    }
    return cleaned;
}
/** FNV-1a over code points; stable, dependency-free, and good enough for ids. */
function hashText(value) {
    let hash = 0x811c9dc5;
    for (const character of value) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
/**
 * Derive an entry id from its text.
 *
 * Deriving rather than randomizing gives idempotent adds for free: the same fact
 * expressed the same way lands on the same id, so "remember X" twice does not
 * grow the store, and a conflicting add is detected instead of duplicated.
 * @param text - normalized entry text.
 */
export function entryId(text) {
    return `m${hashText(normalizeEntryText(text).toLowerCase())}`;
}
/** One in-memory view of a store file, with the invariants enforced in code. */
export class MemoryStore {
    #entries = [];
    #revision = 0;
    #updatedAt = 0;
    #source = 'empty';
    /**
     * The revision this in-memory state was loaded from (or last persisted at).
     *
     * `commit` compares this against the revision actually on disk, so a write
     * that would overwrite another process's committed entries is refused instead
     * of silently dropping them. Mutations bump {@link MemoryStore.revision} but
     * never this — the disk has not moved until a commit lands.
     */
    #diskRevision = 0;
    /** Which tier this store represents. */
    tier;
    #limits;
    /**
     * @param tier - which tier this store represents.
     * @param limits - the configured ceilings.
     */
    constructor(tier, limits) {
        this.tier = tier;
        this.#limits = limits;
    }
    /** Where this state came from, for diagnostics: a path, or `empty`. */
    get source() {
        return this.#source;
    }
    /** Current committed revision. */
    get revision() {
        return this.#revision;
    }
    /**
     * The revision this state was loaded from (or last persisted at).
     *
     * Compare against the on-disk file before writing: a mismatch means another
     * writer committed in between, and the write must be refused rather than
     * overwrite entries this process never saw.
     */
    get diskRevision() {
        return this.#diskRevision;
    }
    /** Record that the current state is now persisted at its {@link MemoryStore.revision}. */
    markPersisted() {
        this.#diskRevision = this.#revision;
    }
    /** When this store was last mutated, epoch milliseconds, or 0 for a fresh store. */
    get updatedAt() {
        return this.#updatedAt;
    }
    /** Number of live entries. */
    get size() {
        return this.#entries.length;
    }
    /** A detached copy of every entry, newest update first. */
    entries() {
        return [...this.#entries].sort((left, right) => right.updatedAt - left.updatedAt);
    }
    /**
     * Load a parsed store file.
     *
     * A file written by a newer format is refused instead of guessed at, because
     * silently dropping fields the running build does not know about is how a
     * memory store loses data without anyone noticing.
     * @param raw - parsed JSON, however malformed.
     * @param source - where it came from, for diagnostics.
     */
    load(raw, source) {
        if (raw === null || typeof raw !== 'object') {
            throw new MemoryError(`memory store at ${source} is not an object`, 'MEMORY_STORE_MALFORMED');
        }
        const file = raw;
        if (file.format !== STORE_FORMAT) {
            throw new MemoryError(`memory store at ${source} uses format ${String(file.format)} but this build reads format ${STORE_FORMAT}`, 'MEMORY_STORE_FORMAT');
        }
        if (!Array.isArray(file.entries)) {
            throw new MemoryError(`memory store at ${source} has no entries array`, 'MEMORY_STORE_MALFORMED');
        }
        // Whole-file bounds are enforced on load, not just on write: a hand-edited
        // or externally corrupted file must not bloat memory or blow the injection
        // budget the moment it is read. Refusing keeps the entries intact on disk
        // for the user to fix, and `memory_status` reports the refusal. The count
        // is over entries that survived filtering, because unusable junk is dropped
        // anyway and must not consume the budget.
        const loaded = [];
        for (const candidate of file.entries) {
            if (candidate === null || typeof candidate !== 'object')
                continue;
            const entry = candidate;
            if (typeof entry.text !== 'string' || entry.text.trim() === '')
                continue;
            const text = normalizeEntryText(entry.text);
            const length = codePointLength(text);
            if (length > this.#limits.maxEntryChars) {
                throw new MemoryError(`memory store at ${source} holds an entry of ${length} characters, above the configured maximum of ${this.#limits.maxEntryChars}. Shorten it in the file and try again.`, 'MEMORY_STORE_MALFORMED');
            }
            const tags = validateTags(Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [], source);
            loaded.push({
                id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : entryId(text),
                text,
                tags,
                createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
                updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
                origin: entry.origin === 'user' ? 'user' : 'consolidator',
                ...(typeof entry.sourceSession === 'string' ? { sourceSession: entry.sourceSession } : {}),
            });
        }
        if (loaded.length > this.#limits.maxEntries) {
            throw new MemoryError(`memory store at ${source} holds ${loaded.length} usable entries, above the configured maximum of ${this.#limits.maxEntries}. Remove some entries in the file and try again.`, 'MEMORY_STORE_MALFORMED');
        }
        this.#entries = loaded;
        this.#revision = typeof file.revision === 'number' ? file.revision : 0;
        this.#diskRevision = this.#revision;
        this.#updatedAt = typeof file.updatedAt === 'number' ? file.updatedAt : 0;
        this.#source = source;
    }
    /** The value to serialize. */
    toFile(now) {
        return {
            format: STORE_FORMAT,
            tier: this.tier,
            revision: this.#revision,
            updatedAt: now,
            entries: this.entries(),
        };
    }
    /** Validate one candidate text against the configured ceilings. */
    #validateText(text) {
        const normalized = normalizeEntryText(text);
        if (normalized === '') {
            throw new MemoryError('a memory entry cannot be empty', 'MEMORY_EMPTY_ENTRY');
        }
        const length = codePointLength(normalized);
        if (length > this.#limits.maxEntryChars) {
            throw new MemoryError(`a memory entry is limited to ${this.#limits.maxEntryChars} characters but this one is ${length}. `
                + 'Shorten it to one self-contained fact; split unrelated facts into separate entries.', 'MEMORY_ENTRY_TOO_LONG');
        }
        return normalized;
    }
    /**
     * Add one entry.
     * @returns the stored entry, plus whether it was newly created.
     * @throws {MemoryError} when the text is invalid, duplicates an existing entry, or the store is full.
     */
    add(input) {
        const text = this.#validateText(input.text);
        const existing = this.#entries.find(entry => entry.id === entryId(text));
        if (existing !== undefined)
            return { entry: existing, created: false };
        if (this.#entries.length >= this.#limits.maxEntries) {
            throw new MemoryError(`this memory tier already holds its maximum of ${this.#limits.maxEntries} entries. `
                + 'Replace an existing entry with memory_update, remove a stale one with memory_delete, '
                + 'or merge several related entries into one before adding.', 'MEMORY_STORE_FULL');
        }
        const entry = {
            id: entryId(text),
            text,
            tags: validateTags(input.tags ?? [], 'a new memory entry'),
            createdAt: input.now,
            updatedAt: input.now,
            origin: input.origin,
            ...(input.sourceSession === undefined ? {} : { sourceSession: input.sourceSession }),
        };
        this.#entries.push(entry);
        this.#revision += 1;
        this.#updatedAt = input.now;
        return { entry, created: true };
    }
    /**
     * Replace one entry's text and tags, keeping its identity and creation time.
     * @throws {MemoryError} when the id is unknown or the replacement is invalid.
     */
    update(input) {
        const index = this.#entries.findIndex(entry => entry.id === input.id);
        if (index === -1) {
            throw new MemoryError(`there is no memory entry with id ${input.id}. Call memory_list to see the current ids.`, 'MEMORY_ENTRY_NOT_FOUND');
        }
        const current = this.#entries[index];
        const text = input.text === undefined ? current.text : this.#validateText(input.text);
        // A rewrite that lands on a different entry's text would silently merge two
        // facts into a duplicate pair, so it is refused as a targeting mistake.
        const collision = this.#entries.find(entry => entry.id === entryId(text) && entry.id !== current.id);
        if (collision !== undefined) {
            throw new MemoryError(`that text is already stored as entry ${collision.id}; rewrite it there instead of duplicating it here`, 'MEMORY_ENTRY_DUPLICATE');
        }
        const updated = {
            ...current,
            text,
            tags: input.tags === undefined ? current.tags : validateTags(input.tags, 'the updated memory entry'),
            updatedAt: input.now,
            origin: input.origin,
        };
        this.#entries[index] = updated;
        this.#revision += 1;
        this.#updatedAt = input.now;
        return updated;
    }
    /**
     * Remove one entry.
     * @throws {MemoryError} when the id is unknown.
     */
    remove(id, now) {
        const index = this.#entries.findIndex(entry => entry.id === id);
        if (index === -1) {
            throw new MemoryError(`there is no memory entry with id ${id}. Call memory_list to see the current ids.`, 'MEMORY_ENTRY_NOT_FOUND');
        }
        const [removed] = this.#entries.splice(index, 1);
        this.#revision += 1;
        this.#updatedAt = now;
        return removed;
    }
    /** List entries, optionally narrowed by a literal case-insensitive substring. */
    list(query) {
        const all = this.entries();
        if (query === undefined || query.trim() === '')
            return all;
        const needle = query.trim().toLowerCase();
        return all.filter(entry => entry.text.toLowerCase().includes(needle)
            || entry.tags.some(tag => tag.toLowerCase().includes(needle)));
    }
}
//# sourceMappingURL=store.js.map
