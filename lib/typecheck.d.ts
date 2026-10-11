/**
 * Compile-time conformance checks between this plugin's structural interfaces and
 * the published Harness SDK types.
 *
 * The plugin deliberately declares narrow structural interfaces instead of
 * importing the SDK's service classes, so that it neither hard-depends on packages
 * it barely uses nor relies on class identity across a version boundary. The cost
 * of that choice is that a structural interface can silently drift from the real
 * one — a changed parameter list would simply stop matching, or worse, keep
 * matching in one direction only.
 *
 * These assignments close that gap at zero runtime cost. They are never executed:
 * every statement is a type assertion over a `declare`d value, and the module
 * exports nothing.
 *
 * @module deepseek-memory/typecheck
 */
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentConsolidator, SubagentRunLike, SubagentStartLike } from './subagent.ts';
export declare const _serviceSatisfiesPlugin: SubagentConsolidator;
export declare const _pluginUsesSubset = true;
export declare const _ctxHasSubagents: () => SubagentRuntime;
export declare function _parentIsAgent(request: SubagentStartLike): Agent;
export declare const _runSatisfiesPlugin: SubagentRunLike;
//# sourceMappingURL=typecheck.d.ts.map