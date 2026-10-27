/**
 * The runtime that owns the two stores on disk.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **The file is the source of truth and stays plain.** A user must be able to
 *    read it, edit it by hand, diff it in git, and delete a line they dislike.
 *    That is the whole reason the store is JSON rather than a database.
 * 2. **A write is atomic and keeps the previous revision.** Memory that can be
 *    half-written is worse than no memory, and the consolidator is a model: it
 *    will sometimes produce something worse than what it replaced, so the old
 *    revision has to remain recoverable.
 *
 * @module deepseek-memory/runtime
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryConfig } from './config.ts'
import { MemoryError, MemoryStore, type MemoryEntry, type MemoryTier } from './store.ts'

/** Directory (under `$DSH_HOME`) holding the user tier. */
export const USER_MEMORY_DIR = 'memory'

/** Directory (under the project root) holding the project tier. */
export const PROJECT_MEMORY_DIR = '.dsh-memory'

/** The store file name inside a tier directory. */
export const STORE_FILE = 'memory.json'

/** Where previous revisions are kept inside a tier directory. */
export const HISTORY_DIR = 'history'

/**
 * Refuse to read a store file larger than this. A store is a small JSON file;
 * one that has grown past 1 MiB has been corrupted or polluted, and parsing it
 * would spend unbounded memory to produce a store the limits would then reject.
 */
export const MAX_STORE_FILE_BYTES = 1_048_576

/** How many previous revisions are kept per tier. Oldest backups are pruned first. */
export const MAX_HISTORY_FILES = 20

/** Total disk budget for a tier's `history/` directory, in bytes. */
export const MAX_HISTORY_BYTES = 5 * 1_048_576

/** Name of the per-tier lock file serializing commits across processes. */
export const LOCK_FILE = '.memory-store.lock'

/** How long to wait for a contended lock before refusing. */
const LOCK_WAIT_MS = 2_000

/** Backoff between lock-acquisition attempts. */
const LOCK_RETRY_MS = 25

/**
 * A lock left behind by a crashed process is reclaimed after this long, so one
 * dead writer cannot lock a tier forever.
 */
const LOCK_STALE_MS = 30_000

/** Sleep synchronously without timers, for lock backoff. */
function sleepSync(milliseconds: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  } catch {
    const end = Date.now() + milliseconds
    while (Date.now() < end) { /* fall back to spinning */ }
  }
}

/** One resolved store location. */
export interface TierLocation {
  readonly tier: MemoryTier
  readonly dir: string
  readonly file: string
  /** Whether the tier directory already exists; creation is not implied by reading. */
  readonly existed: boolean
}

/** Outcome of one committed mutation, for logs and for the tool result. */
export interface CommitResult {
  /** Revision number after the commit. */
  readonly revision: number
  /** Previous-revision backup path, when one was written. */
  readonly historyPath?: string
}

/**
 * Owns both tiers' files and every mutation to them.
 *
 * Reads are cached per tier for the life of the plugin: the files are small, and
 * re-reading them on every prompt assembly would put filesystem work on the
 * request path. The cache is refreshed at the start of each consolidation and
 * whenever a tool mutates, so external edits become visible at those points.
 */
export class MemoryRuntime {
  #stores = new Map<MemoryTier, MemoryStore>()
  #locations = new Map<MemoryTier, TierLocation>()

  readonly #config: MemoryConfig
  readonly #dshHome: string | undefined
  /**
   * Resolved on demand, not captured once.
   *
   * The project directory is not knowable when the plugin is applied: it comes
   * from the session's own record, which only exists once a session event arrives.
   * A getter is also what lets a host switch projects without restarting the
   * plugin. See `resolveCwd` in `./index.ts` for why the process working directory
   * alone is not trustworthy.
   */
  readonly #cwd: () => string | null | undefined
  /** The value `#cwd()` last produced, so a change can invalidate the cache. */
  #cwdSeen: string | null | undefined
  readonly #now: () => number

  /**
   * @param config - validated plugin configuration.
   * @param dshHome - the resolved harness home, or undefined to disable the user tier.
   * @param cwd - resolves the session project directory; null/undefined disables the project tier. A plain string is accepted for callers with a fixed directory.
   * @param now - clock injection, so tests are deterministic.
   */
  constructor(
    config: MemoryConfig,
    dshHome: string | undefined,
    cwd: (() => string | null | undefined) | string | null | undefined,
    now: () => number = Date.now,
  ) {
    this.#config = config
    this.#dshHome = dshHome
    this.#cwd = typeof cwd === 'function' ? cwd : () => cwd
    this.#cwdSeen = this.#cwd()
    this.#now = now
  }

  /**
   * The current project directory.
   *
   * When it changes, every memoized location and loaded store is dropped: they
   * describe the old tree, and continuing to read them would show one project's
   * memory while the user works in another.
   */
  #projectDir(): string | null | undefined {
    const current = this.#cwd()
    if (current !== this.#cwdSeen) {
      this.#cwdSeen = current
      this.#locations.clear()
      this.#stores.clear()
    }
    return current
  }

  /** Tiers that are enabled and have a usable location. */
  enabledTiers(): MemoryTier[] {
    const tiers: MemoryTier[] = []
    const cwd = this.#projectDir()
    if (this.#config.project && typeof cwd === 'string' && cwd !== '') tiers.push('project')
    if (this.#config.user && typeof this.#dshHome === 'string' && this.#dshHome !== '') tiers.push('user')
    return tiers
  }

  /** Resolve (and memoize) one tier's location. */
  #location(tier: MemoryTier): TierLocation {
    const cached = this.#locations.get(tier)
    if (cached !== undefined) return cached
    const dir = tier === 'project'
      ? join(this.#projectDir() ?? '', PROJECT_MEMORY_DIR)
      : join(this.#dshHome ?? '', USER_MEMORY_DIR)
    const location: TierLocation = { tier, dir, file: join(dir, STORE_FILE), existed: existsSync(dir) }
    this.#locations.set(tier, location)
    return location
  }

  /** The store for one tier, loaded from disk on first use. */
  store(tier: MemoryTier): MemoryStore {
    const cached = this.#stores.get(tier)
    if (cached !== undefined) return cached
    const location = this.#location(tier)
    const store = new MemoryStore(tier, {
      maxEntries: this.#config.maxEntries,
      maxEntryChars: this.#config.maxEntryChars,
    })
    if (existsSync(location.file)) {
      try {
        if (statSync(location.file).size > MAX_STORE_FILE_BYTES) {
          throw new MemoryError(
            `memory store at ${location.file} is larger than ${MAX_STORE_FILE_BYTES} bytes, which a curated memory store should never reach. Inspect the file by hand; it may have been polluted.`,
            'MEMORY_STORE_MALFORMED',
          )
        }
        store.load(JSON.parse(readFileSync(location.file, 'utf8')), location.file)
      } catch (error) {
        // A malformed store must not take the plugin down with it: the user can
        // still see the file and fix it, and everything else keeps working.
        throw error instanceof MemoryError
          ? new MemoryError(`${error.message}`, error.code)
          : new MemoryError(
            `memory store at ${location.file} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
            'MEMORY_STORE_UNREADABLE',
          )
      }
    }
    this.#stores.set(tier, store)
    return store
  }

  /** Every enabled tier's store, in injection priority order. */
  stores(): { tier: MemoryTier; store: MemoryStore }[] {
    return this.enabledTiers().map(tier => ({ tier, store: this.store(tier) }))
  }

  /** Drop the cache so the next read observes on-disk edits. */
  refresh(): void {
    this.#stores.clear()
    this.#locations.clear()
  }

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
   * Both refusals drop the tier's cached copy so the next read sees the
   * on-disk truth, and throw a {@link MemoryError} whose message the model (or a
   * retry loop) can act on.
   * @param tier - which store to persist.
   * @param expected - the store object the caller mutated, when the caller holds one.
   */
  commit(tier: MemoryTier, expected?: MemoryStore): CommitResult | undefined {
    const store = this.store(tier)
    const location = this.#location(tier)

    if (expected !== undefined && expected !== store) {
      this.#stores.delete(tier)
      throw new MemoryError(
        `the ${tier} memory store was refreshed mid-write, so the pending change was made against a state this session no longer holds. The write was refused rather than risk overwriting newer state; re-read the store and retry.`,
        'MEMORY_STORE_STALE',
      )
    }

    mkdirSync(location.dir, { recursive: true })

    // The whole check-and-write sequence runs under the per-tier lock, so two
    // processes cannot pass the revision check against the same base revision
    // and then both write (a lost update either way).
    return this.#withLock(location, () => {
      if (existsSync(location.file)) {
        let diskRevision: number | undefined
        try {
          const parsed = JSON.parse(readFileSync(location.file, 'utf8')) as { revision?: unknown }
          if (typeof parsed?.revision === 'number') diskRevision = parsed.revision
        } catch {
          // An unparseable file is left to the write path below: atomic rename
          // replaces it whole, which is the same recovery `memory_status` reports.
          diskRevision = undefined
        }
        if (diskRevision !== undefined && diskRevision !== store.diskRevision) {
          // Another process committed this tier after we loaded it. Their entries
          // are real; dropping them silently is the failure a memory store must
          // not have. Drop the stale cache so the next read sees the truth.
          this.#stores.delete(tier)
          throw new MemoryError(
            `the ${tier} memory store was changed by another process since this session loaded it (disk revision ${diskRevision}, loaded revision ${store.diskRevision}). The write was refused instead of overwriting the other writer's entries; re-read the store, merge, and retry.`,
            'MEMORY_STORE_CONFLICT',
          )
        }
      }

      let historyPath: string | undefined
      if (this.#config.keepHistory && existsSync(location.file)) {
        try {
          const historyDir = join(location.dir, HISTORY_DIR)
          mkdirSync(historyDir, { recursive: true })
          historyPath = join(historyDir, `${new Date(this.#now()).toISOString().replace(/[:.]/g, '-')}.json`)
          writeFileSync(historyPath, readFileSync(location.file))
          this.#pruneHistory(historyDir)
        } catch (error) {
          // History is a convenience; losing it must never fail the write itself.
          // The failure is logged so a recurring backup problem is diagnosable.
          console.warn(`[memory] could not keep a history backup for the ${tier} tier: ${error instanceof Error ? error.message : String(error)}`)
          historyPath = undefined
        }
      }

      // Temp file with a unique name, then rename: an interrupted write leaves
      // the old file intact, concurrent commits in one process cannot collide on
      // the temp name, and a failed write cleans up after itself.
      const payload = `${JSON.stringify(store.toFile(this.#now()), undefined, 2)}\n`
      const temp = `${location.file}.tmp-${process.pid}-${randomUUID()}`
      try {
        writeFileSync(temp, payload, 'utf8')
        renameSync(temp, location.file)
      } catch (error) {
        try { rmSync(temp, { force: true }) } catch { /* nothing left to clean */ }
        throw error
      }
      store.markPersisted()
      return historyPath === undefined ? { revision: store.revision } : { revision: store.revision, historyPath }
    })
  }

  /**
   * Run one action holding the tier's lock file.
   *
   * The lock is an exclusive-create file: every process taking this path agrees
   * to create it first and remove it when done, which turns check-then-write
   * into an atomic step across processes. A lock whose mtime is older than
   * {@link LOCK_STALE_MS} is reclaimed, so a crashed writer cannot lock a tier
   * forever; contention past {@link LOCK_WAIT_MS} is refused rather than
   * queued, because a commit that cannot land in two seconds is better retried
   * by the caller with fresh state.
   */
  #withLock<T>(location: TierLocation, action: () => T): T {
    const lockPath = join(location.dir, LOCK_FILE)
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = openSync(lockPath, 'wx')
        try {
          writeFileSync(handle, `${process.pid}\n`)
        } finally {
          closeSync(handle)
        }
        try {
          return action()
        } finally {
          try { unlinkSync(lockPath) } catch { /* a lock another process already reclaimed */ }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (this.#isStaleLock(lockPath)) {
          try { rmSync(lockPath, { force: true }) } catch { /* raced with another reclaimer */ }
          continue
        }
        if (Date.now() >= deadline) {
          throw new MemoryError(
            `the ${location.tier} memory store is being written by another process and did not release within ${LOCK_WAIT_MS / 1000} seconds. The write was refused; retry shortly.`,
            'MEMORY_STORE_LOCKED',
          )
        }
        sleepSync(LOCK_RETRY_MS)
      }
    }
  }

  /** Whether the lock file exists and was last touched long enough ago to belong to a dead writer. */
  #isStaleLock(lockPath: string): boolean {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
    } catch {
      return false
    }
  }

  /**
   * Bound a tier's `history/` directory.
   *
   * Keeps at most {@link MAX_HISTORY_FILES} backups and {@link MAX_HISTORY_BYTES}
   * of backup bytes, deleting the oldest first — backup names are timestamps, so
   * lexical order is chronological. Called after a successful backup; its
   * failures are contained by the caller.
   */
  #pruneHistory(historyDir: string): void {
    const names = readdirSync(historyDir).filter(name => name.endsWith('.json')).sort()
    let total = 0
    const sizes = new Map<string, number>()
    for (const name of names) {
      const size = statSync(join(historyDir, name)).size
      sizes.set(name, size)
      total += size
    }
    const remove = (name: string): void => {
      try { rmSync(join(historyDir, name), { force: true }) } catch { /* already gone */ }
      total -= sizes.get(name) ?? 0
    }
    // Oldest first.
    while (names.length > MAX_HISTORY_FILES) remove(names.shift()!)
    for (const name of names) {
      if (total <= MAX_HISTORY_BYTES) break
      remove(name)
    }
  }

  /** Convenience: the entry list a tool should show for one tier. */
  list(tier: MemoryTier, query?: string): MemoryEntry[] {
    return this.store(tier).list(query)
  }

  /** Diagnose where each tier lives, for `memory_status` and for logs. */
  describe(): { tier: MemoryTier; file: string; dir: string; entries: number; revision: number; readable: boolean }[] {
    return this.enabledTiers().map((tier) => {
      const location = this.#location(tier)
      try {
        const store = this.store(tier)
        return { tier, file: location.file, dir: location.dir, entries: store.size, revision: store.revision, readable: true }
      } catch {
        return { tier, file: location.file, dir: location.dir, entries: 0, revision: 0, readable: false }
      }
    })
  }
}

/** The directory a tier owns, without touching the filesystem. */
export function tierDirFor(tier: MemoryTier, dshHome: string | undefined, cwd: string | null | undefined): string {
  return tier === 'project' ? join(cwd ?? '', PROJECT_MEMORY_DIR) : join(dshHome ?? '', USER_MEMORY_DIR)
}
