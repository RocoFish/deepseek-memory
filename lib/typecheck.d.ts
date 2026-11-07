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
 * Checked against `@deepseek-ai/dsh-subagent@0.2.2-rc.1` (see CHANGELOG 0.1.1):
 * 0.2.2 removed `SubagentRuntime.start()` in favour of `startActivation()`. The
 * plugin's child path needs the per-request `toolFilter` narrowing that
 * `startActivation()` does not offer for a fresh child, so the plugin treats the
 * activation-only surface as "cannot narrow" and fails closed to the direct model
 * path. The assertions below pin the shapes the plugin still relies on:
 * `SubagentActivation` must remain structurally usable as a run handle, and its
 * settled result must remain structurally usable as a run receipt.
 *
 * @module deepseek-memory/typecheck
 */
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRunLike, SubagentStartLike } from './subagent.ts';
export declare const _serviceRecognized: {
    readonly startActivation: unknown;
};
export declare const _ctxHasSubagents: () => SubagentRuntime;
export declare function _parentIsAgent(request: SubagentStartLike): Agent;
export declare const _activationFitsRunHandle: SubagentRunLike;
export declare const _activationResultFitsReceipt: Awaited<SubagentRunLike['result']>;
//# sourceMappingURL=typecheck.d.ts.map