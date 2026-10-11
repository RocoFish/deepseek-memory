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
'off'
/** Run only when a turn shows a cheap, local signal that something is worth remembering. */
 | 'gated'
/** Run after every closed turn. Faithful but pays one model call per turn. */
 | 'always';
/** Resolved plugin configuration. */
export interface MemoryConfig {
    /** Enable the `user` tier (`$DSH_HOME/memory/memory.json`). */
    readonly user: boolean;
    /** Enable the `project` tier (`<cwd>/.dsh-memory/memory.json`). */
    readonly project: boolean;
    /** Maximum entries per tier. */
    readonly maxEntries: number;
    /** Maximum Unicode code points per entry. */
    readonly maxEntryChars: number;
    /** Maximum characters of memory text injected into one request. */
    readonly injectChars: number;
    /** Register the memory tools for the model. */
    readonly tools: boolean;
    /** After-turn consolidation policy. */
    readonly consolidation: ConsolidationMode;
    /** Minimum closed turns between two consolidator runs in one session. */
    readonly minTurnsBetweenRuns: number;
    /** Keep the previous revision of each store in `history/`. */
    readonly keepHistory: boolean;
    /**
     * Which registered **subagent provider** the consolidator child is started on.
     * This is a provider *name*, not a model route — they are different namespaces
     * and conflating them silently breaks deployments that register their own.
     */
    readonly consolidationSubagentProvider: string;
    /**
     * Model route for the **direct fallback** path, used only when no subagent
     * provider is available. Omit to reuse the session's own logged route.
     */
    readonly consolidationRouteProvider: string | undefined;
    /** Model id paired with `consolidationRouteProvider`. */
    readonly consolidationRouteModel: string | undefined;
    /**
     * Wall-clock cap for one consolidation, in milliseconds. Bounds a child that
     * hangs, and bounds the direct model request's own signal.
     */
    readonly consolidationTimeoutMs: number;
}
/** Defaults chosen so an untouched install is safe and quiet. */
export declare const DEFAULT_CONFIG: MemoryConfig;
/**
 * Merge user configuration onto the defaults and enforce every bound.
 * @param raw - whatever the loader passed as plugin config.
 */
export declare function resolveConfig(raw: unknown): MemoryConfig;
//# sourceMappingURL=config.d.ts.map