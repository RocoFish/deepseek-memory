import type { ToolDefinition } from './define.ts';
import type { MemoryTier } from './store.ts';
import type { MemoryRuntime } from './runtime.ts';
/** Tools accept an explicit tier, or `auto` to pick the most specific live one. */
export type TierChoice = MemoryTier | 'auto';
/**
 * What the plugin resolved at load time, surfaced by `memory_status`.
 *
 * A tier can be off for reasons invisible from the outside — a disabled config
 * flag, an unresolvable home — and a disabled tier looks exactly like an empty one.
 * Reporting the source turns "why is my user memory not working" into a reading of
 * the tool's own output instead of a debugging session.
 */
export interface MemoryDiagnostics {
    /** Which candidate supplied the harness home. */
    readonly homeSource: string;
    /** The resolved harness home, when one was found. */
    readonly home: string | undefined;
    /** The project directory in effect when the plugin loaded. */
    readonly projectDir: string | undefined;
}
/**
 * Build the memory tool definitions.
 *
 * Synchronous, and dependent on nothing outside this package: the definition
 * helper is implemented locally (see `./define.ts` for why). That is the whole
 * point — a tool surface that needs a module the profile cannot resolve is a
 * tool surface that is silently absent on a real install.
 *
 * @param runtime - the store owner.
 * @param diagnostics - what the plugin resolved at load time, for `memory_status`.
 * @returns registry-ready definitions in registration order.
 */
export declare function createMemoryTools(runtime: MemoryRuntime, diagnostics?: MemoryDiagnostics): ToolDefinition[];
//# sourceMappingURL=tools.d.ts.map
