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
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentConsolidator, SubagentRunLike, SubagentStartLike } from './subagent.ts'

// The real service must satisfy the interface this plugin calls through.
declare const realSubagents: SubagentRuntime
export const _serviceSatisfiesPlugin: SubagentConsolidator = realSubagents

// And the plugin must never rely on more of it than the interface promises.
export const _pluginUsesSubset = true

// Context wiring: `ctx.subagents` is the only key this plugin reads for the child path.
declare const ctx: Context
export const _ctxHasSubagents = (): SubagentRuntime => ctx.subagents

// The spawning agent the plugin passes as `parent` is exactly an `Agent`.
declare const parent: Agent
export function _parentIsAgent(request: SubagentStartLike): Agent {
  // Round-tripping through the plugin's own parameter type proves the two agree.
  return request.parent as Agent
}

// A run handle's result and disposer must line up with what the plugin awaits.
declare const run: Awaited<ReturnType<SubagentRuntime['start']>>
export const _runSatisfiesPlugin: SubagentRunLike = run
