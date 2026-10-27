/**
 * Plugin configuration.
 *
 * Every option is explicit and bounded: an unconfigured memory plugin must not be
 * able to grow an unbounded prompt section or an unbounded file, because those
 * are the two failures that make a memory feature worse than none.
 *
 * @module deepseek-memory/config
 */

/** How aggressively the store is maintained after a turn closes. */
export type ConsolidationMode =
  /** Never run a consolidator. Memory only changes when the model calls a tool or the user edits the file. */
  | 'off'
  /** Run only when a turn shows a cheap, local signal that something is worth remembering. */
  | 'gated'
  /** Run after every closed turn. Faithful but pays one model call per turn. */
  | 'always'

/** Resolved plugin configuration. */
export interface MemoryConfig {
  /** Enable the `user` tier (`$DSH_HOME/memory/memory.json`). */
  readonly user: boolean
  /** Enable the `project` tier (`<cwd>/.dsh-memory/memory.json`). */
  readonly project: boolean
  /** Maximum entries per tier. */
  readonly maxEntries: number
  /** Maximum Unicode code points per entry. */
  readonly maxEntryChars: number
  /** Maximum characters of memory text injected into one request. */
  readonly injectChars: number
  /** Register the memory tools for the model. */
  readonly tools: boolean
  /** After-turn consolidation policy. */
  readonly consolidation: ConsolidationMode
  /** Minimum closed turns between two consolidator runs in one session. */
  readonly minTurnsBetweenRuns: number
  /** Keep the previous revision of each store in `history/`. */
  readonly keepHistory: boolean
  /**
   * Which registered **subagent provider** the consolidator child is started on.
   * This is a provider *name*, not a model route — they are different namespaces
   * and conflating them silently breaks deployments that register their own.
   */
  readonly consolidationSubagentProvider: string
  /**
   * Model route for the **direct fallback** path, used only when no subagent
   * provider is available. Omit to reuse the session's own logged route.
   */
  readonly consolidationRouteProvider: string | undefined
  /** Model id paired with `consolidationRouteProvider`. */
  readonly consolidationRouteModel: string | undefined
  /**
   * Wall-clock cap for one consolidation, in milliseconds. Bounds a child that
   * hangs, and bounds the direct model request's own signal.
   */
  readonly consolidationTimeoutMs: number
}

/** Defaults chosen so an untouched install is safe and quiet. */
export const DEFAULT_CONFIG: MemoryConfig = {
  user: true,
  project: true,
  maxEntries: 50,
  maxEntryChars: 500,
  injectChars: 4000,
  tools: true,
  consolidation: 'gated',
  minTurnsBetweenRuns: 1,
  keepHistory: true,
  consolidationSubagentProvider: 'in-process',
  consolidationRouteProvider: undefined,
  consolidationRouteModel: undefined,
  consolidationTimeoutMs: 120_000,
}

/**
 * Hard ceilings on resource-shaped options, so a config typo cannot turn one
 * request — or one store file — into an unbounded resource sink. These are
 * deliberately generous: every default sits two orders of magnitude below its
 * ceiling, and the ceilings only exist to catch configuration that slipped a
 * decimal or a unit.
 */
const LIMITS = {
  /** Entries per tier. The store is meant to be read whole by a human. */
  maxEntries: 500,
  /** Code points per entry. Even a "long" memory is a paragraph. */
  maxEntryChars: 2_000,
  /** Characters of memory text injected into one request. */
  injectChars: 50_000,
  /** Closed turns between consolidator runs. */
  minTurnsBetweenRuns: 100,
  /** Wall-clock cap for one consolidation, in milliseconds. */
  consolidationTimeoutMs: 600_000,
} as const

/**
 * Clamp a numeric option into a sane range, ignoring nonsense values.
 *
 * Values below the floor fall back to the default (they are nonsense); values
 * above the ceiling clamp to the ceiling (they are configuration that slipped a
 * unit, and refusing the whole config over one slipped value would be worse than
 * bounding it).
 *
 * Configuration is validated here rather than by a schema library. That is a
 * deliberate trade: the harness's native `schemastery` cannot express this
 * config's type portably (its defaulting wrappers widen `boolean` to
 * `boolean | Volatile<boolean>`, so declaration emit either fails as
 * non-portable or rejects the annotation), and every rule this config actually
 * needs — positive counts, a floor on the entry cap, a closed union for the
 * consolidation mode — is a few explicit lines below. Dropping the dependency
 * also keeps the published package smaller.
 */
function positive(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) return fallback
  return Math.min(Math.floor(value), maximum)
}

/** A non-empty string option, or undefined when absent or blank. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Merge user configuration onto the defaults and enforce every bound.
 * @param raw - whatever the loader passed as plugin config.
 */
export function resolveConfig(raw: unknown): MemoryConfig {
  const input = (raw ?? {}) as Partial<MemoryConfig>
  return {
    user: input.user !== false,
    project: input.project !== false,
    maxEntries: positive(input.maxEntries, DEFAULT_CONFIG.maxEntries, 1, LIMITS.maxEntries),
    maxEntryChars: positive(input.maxEntryChars, DEFAULT_CONFIG.maxEntryChars, 16, LIMITS.maxEntryChars),
    injectChars: positive(input.injectChars, DEFAULT_CONFIG.injectChars, 0, LIMITS.injectChars),
    tools: input.tools !== false,
    consolidation: input.consolidation === 'off' || input.consolidation === 'always'
      ? input.consolidation
      : DEFAULT_CONFIG.consolidation,
    minTurnsBetweenRuns: positive(input.minTurnsBetweenRuns, DEFAULT_CONFIG.minTurnsBetweenRuns, 0, LIMITS.minTurnsBetweenRuns),
    keepHistory: input.keepHistory !== false,
    consolidationSubagentProvider: optionalString(input.consolidationSubagentProvider) ?? DEFAULT_CONFIG.consolidationSubagentProvider,
    consolidationRouteProvider: optionalString(input.consolidationRouteProvider),
    consolidationRouteModel: optionalString(input.consolidationRouteModel),
    consolidationTimeoutMs: positive(input.consolidationTimeoutMs, DEFAULT_CONFIG.consolidationTimeoutMs, 1_000, LIMITS.consolidationTimeoutMs),
  }
}
