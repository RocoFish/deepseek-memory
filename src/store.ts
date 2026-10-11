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
export const DEFAULT_MAX_ENTRIES = 50

/** Hard ceiling on one entry's length, in Unicode code points. */
export const DEFAULT_MAX_ENTRY_CHARS = 500

/** Current on-disk format. A newer file is refused rather than misread. */
export const STORE_FORMAT = 1

/** Which tier a store belongs to. */
export type MemoryTier = 'user' | 'project'

/** One curated memory entry. */
export interface MemoryEntry {
  /** Short stable id, derived from the text so re-adding the same fact is a no-op. */
  readonly id: string
  /** The remembered fact, one self-contained sentence or two. */
  readonly text: string
  /** Free-form labels for the injector's section ordering and manual browsing. */
  readonly tags: readonly string[]
  /** Creation time, epoch milliseconds. */
  readonly createdAt: number
  /** Last modification time, epoch milliseconds. */
  readonly updatedAt: number
  /** How the entry last changed, for audit and for the UI. */
  readonly origin: 'user' | 'consolidator'
  /** The session that produced the entry, when known. */
  readonly sourceSession?: string
}

/** The serialized store file. */
export interface StoreFile {
  readonly format: number
  readonly tier: MemoryTier
  /** Monotonic revision, bumped by every committed mutation. */
  readonly revision: number
  readonly updatedAt: number
  readonly entries: readonly MemoryEntry[]
}

/** A refusal the caller is expected to surface to the model verbatim. */
export class MemoryError extends Error {
  /** Stable machine-readable discriminant. */
  readonly code: string

  /**
   * @param message - teaching text the model can act on.
   * @param code - stable machine-readable discriminant.
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/** Trim, collapse whitespace runs, and drop framing the model already understands. */
export function normalizeEntryText(value: string): string {
  return value
    .replace(/<\/?system-reminder>/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Unicode code-point length, so the cap means the same thing for CJK and Latin. */
export function codePointLength(value: string): number {
  return [...value].length
}

/** FNV-1a over code points; stable, dependency-free, and good enough for ids. */
function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Derive an entry id from its text.
 *
 * Deriving rather than randomizing gives idempotent adds for free: the same fact
 * expressed the same way lands on the same id, so "remember X" twice does not
 * grow the store, and a conflicting add is detected instead of duplicated.
 * @param text - normalized entry text.
 */
export function entryId(text: string): string {
  return `m${hashText(normalizeEntryText(text).toLowerCase())}`
}

/** One in-memory view of a store file, with the invariants enforced in code. */
export class MemoryStore {
  #entries: MemoryEntry[] = []
  #revision = 0
  #updatedAt = 0
  #source = 'empty'

  /** Which tier this store represents. */
  readonly tier: MemoryTier
  readonly #limits: { maxEntries: number; maxEntryChars: number }

  /**
   * @param tier - which tier this store represents.
   * @param limits - the configured ceilings.
   */
  constructor(tier: MemoryTier, limits: { maxEntries: number; maxEntryChars: number }) {
    this.tier = tier
    this.#limits = limits
  }

  /** Where this state came from, for diagnostics: a path, or `empty`. */
  get source(): string {
    return this.#source
  }

  /** Current committed revision. */
  get revision(): number {
    return this.#revision
  }

  /** When this store was last mutated, epoch milliseconds, or 0 for a fresh store. */
  get updatedAt(): number {
    return this.#updatedAt
  }

  /** Number of live entries. */
  get size(): number {
    return this.#entries.length
  }

  /** A detached copy of every entry, newest update first. */
  entries(): MemoryEntry[] {
    return [...this.#entries].sort((left, right) => right.updatedAt - left.updatedAt)
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
  load(raw: unknown, source: string): void {
    if (raw === null || typeof raw !== 'object') {
      throw new MemoryError(`memory store at ${source} is not an object`, 'MEMORY_STORE_MALFORMED')
    }
    const file = raw as Partial<StoreFile>
    if (file.format !== STORE_FORMAT) {
      throw new MemoryError(
        `memory store at ${source} uses format ${String(file.format)} but this build reads format ${STORE_FORMAT}`,
        'MEMORY_STORE_FORMAT',
      )
    }
    if (!Array.isArray(file.entries)) {
      throw new MemoryError(`memory store at ${source} has no entries array`, 'MEMORY_STORE_MALFORMED')
    }
    const loaded: MemoryEntry[] = []
    for (const candidate of file.entries) {
      if (candidate === null || typeof candidate !== 'object') continue
      const entry = candidate as Partial<MemoryEntry>
      if (typeof entry.text !== 'string' || entry.text.trim() === '') continue
      const text = normalizeEntryText(entry.text)
      loaded.push({
        id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : entryId(text),
        text,
        tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        origin: entry.origin === 'user' ? 'user' : 'consolidator',
        ...(typeof entry.sourceSession === 'string' ? { sourceSession: entry.sourceSession } : {}),
      })
    }
    this.#entries = loaded
    this.#revision = typeof file.revision === 'number' ? file.revision : 0
    this.#updatedAt = typeof file.updatedAt === 'number' ? file.updatedAt : 0
    this.#source = source
  }

  /** The value to serialize. */
  toFile(now: number): StoreFile {
    return {
      format: STORE_FORMAT,
      tier: this.tier,
      revision: this.#revision,
      updatedAt: now,
      entries: this.entries(),
    }
  }

  /** Validate one candidate text against the configured ceilings. */
  #validateText(text: string): string {
    const normalized = normalizeEntryText(text)
    if (normalized === '') {
      throw new MemoryError('a memory entry cannot be empty', 'MEMORY_EMPTY_ENTRY')
    }
    const length = codePointLength(normalized)
    if (length > this.#limits.maxEntryChars) {
      throw new MemoryError(
        `a memory entry is limited to ${this.#limits.maxEntryChars} characters but this one is ${length}. `
        + 'Shorten it to one self-contained fact; split unrelated facts into separate entries.',
        'MEMORY_ENTRY_TOO_LONG',
      )
    }
    return normalized
  }

  /**
   * Add one entry.
   * @returns the stored entry, plus whether it was newly created.
   * @throws {MemoryError} when the text is invalid, duplicates an existing entry, or the store is full.
   */
  add(input: { text: string; tags?: readonly string[]; origin: MemoryEntry['origin']; sourceSession?: string; now: number }): { entry: MemoryEntry; created: boolean } {
    const text = this.#validateText(input.text)
    const existing = this.#entries.find(entry => entry.id === entryId(text))
    if (existing !== undefined) return { entry: existing, created: false }

    if (this.#entries.length >= this.#limits.maxEntries) {
      throw new MemoryError(
        `this memory tier already holds its maximum of ${this.#limits.maxEntries} entries. `
        + 'Replace an existing entry with memory_update, remove a stale one with memory_delete, '
        + 'or merge several related entries into one before adding.',
        'MEMORY_STORE_FULL',
      )
    }

    const entry: MemoryEntry = {
      id: entryId(text),
      text,
      tags: [...(input.tags ?? [])],
      createdAt: input.now,
      updatedAt: input.now,
      origin: input.origin,
      ...(input.sourceSession === undefined ? {} : { sourceSession: input.sourceSession }),
    }
    this.#entries.push(entry)
    this.#revision += 1
    this.#updatedAt = input.now
    return { entry, created: true }
  }

  /**
   * Replace one entry's text and tags, keeping its identity and creation time.
   * @throws {MemoryError} when the id is unknown or the replacement is invalid.
   */
  update(input: { id: string; text?: string; tags?: readonly string[]; origin: MemoryEntry['origin']; now: number }): MemoryEntry {
    const index = this.#entries.findIndex(entry => entry.id === input.id)
    if (index === -1) {
      throw new MemoryError(
        `there is no memory entry with id ${input.id}. Call memory_list to see the current ids.`,
        'MEMORY_ENTRY_NOT_FOUND',
      )
    }
    const current = this.#entries[index]!
    const text = input.text === undefined ? current.text : this.#validateText(input.text)
    // A rewrite that lands on a different entry's text would silently merge two
    // facts into a duplicate pair, so it is refused as a targeting mistake.
    const collision = this.#entries.find(entry => entry.id === entryId(text) && entry.id !== current.id)
    if (collision !== undefined) {
      throw new MemoryError(
        `that text is already stored as entry ${collision.id}; rewrite it there instead of duplicating it here`,
        'MEMORY_ENTRY_DUPLICATE',
      )
    }
    const updated: MemoryEntry = {
      ...current,
      text,
      tags: input.tags === undefined ? current.tags : [...input.tags],
      updatedAt: input.now,
      origin: input.origin,
    }
    this.#entries[index] = updated
    this.#revision += 1
    this.#updatedAt = input.now
    return updated
  }

  /**
   * Remove one entry.
   * @throws {MemoryError} when the id is unknown.
   */
  remove(id: string, now: number): MemoryEntry {
    const index = this.#entries.findIndex(entry => entry.id === id)
    if (index === -1) {
      throw new MemoryError(
        `there is no memory entry with id ${id}. Call memory_list to see the current ids.`,
        'MEMORY_ENTRY_NOT_FOUND',
      )
    }
    const [removed] = this.#entries.splice(index, 1)
    this.#revision += 1
    this.#updatedAt = now
    return removed!
  }

  /** List entries, optionally narrowed by a literal case-insensitive substring. */
  list(query?: string): MemoryEntry[] {
    const all = this.entries()
    if (query === undefined || query.trim() === '') return all
    const needle = query.trim().toLowerCase()
    return all.filter(entry =>
      entry.text.toLowerCase().includes(needle)
      || entry.tags.some(tag => tag.toLowerCase().includes(needle)))
  }
}
