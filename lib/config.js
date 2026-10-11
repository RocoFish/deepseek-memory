/**
 * Plugin configuration.
 *
 * Every option is explicit and bounded: an unconfigured memory plugin must not be
 * able to grow an unbounded prompt section or an unbounded file, because those
 * are the two failures that make a memory feature worse than none.
 *
 * @module deepseek-memory/config
 */
/** Defaults chosen so an untouched install is safe and quiet. */
export const DEFAULT_CONFIG = {
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
};
/**
 * Clamp a numeric option into a sane range, ignoring nonsense values.
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
function positive(value, fallback, minimum) {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum
        ? Math.floor(value)
        : fallback;
}
/** A non-empty string option, or undefined when absent or blank. */
function optionalString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
/**
 * Merge user configuration onto the defaults and enforce every bound.
 * @param raw - whatever the loader passed as plugin config.
 */
export function resolveConfig(raw) {
    const input = (raw ?? {});
    return {
        user: input.user !== false,
        project: input.project !== false,
        maxEntries: positive(input.maxEntries, DEFAULT_CONFIG.maxEntries, 1),
        maxEntryChars: positive(input.maxEntryChars, DEFAULT_CONFIG.maxEntryChars, 16),
        injectChars: positive(input.injectChars, DEFAULT_CONFIG.injectChars, 0),
        tools: input.tools !== false,
        consolidation: input.consolidation === 'off' || input.consolidation === 'always'
            ? input.consolidation
            : DEFAULT_CONFIG.consolidation,
        minTurnsBetweenRuns: positive(input.minTurnsBetweenRuns, DEFAULT_CONFIG.minTurnsBetweenRuns, 0),
        keepHistory: input.keepHistory !== false,
        consolidationSubagentProvider: optionalString(input.consolidationSubagentProvider) ?? DEFAULT_CONFIG.consolidationSubagentProvider,
        consolidationRouteProvider: optionalString(input.consolidationRouteProvider),
        consolidationRouteModel: optionalString(input.consolidationRouteModel),
        consolidationTimeoutMs: positive(input.consolidationTimeoutMs, DEFAULT_CONFIG.consolidationTimeoutMs, 1_000),
    };
}
//# sourceMappingURL=config.js.map