/**
 * The restricted child agent that performs memory consolidation.
 *
 * Why a child agent rather than a bare model call: consolidation is a reasoning
 * task over a transcript, and the harness already has a construct for "a separate
 * agent with its own context and its own narrowed authority". Using it buys three
 * things a hand-rolled single request cannot:
 *
 * - **Real narrowing.** `toolFilter` removes every tool but the memory ones from
 *   the child's prompt *and* refuses them at execution, so the child cannot read
 *   or write the repository no matter what the transcript talks it into.
 * - **No parent history.** The child starts fresh, so consolidation never inflates
 *   the main conversation's tokens, and a noisy turn cannot leak into it.
 * - **A structured receipt.** `outputSchema` makes the child return a report the
 *   plugin can compare against what actually changed.
 *
 * The child writes the store through the plugin's own registered memory tools, so
 * every ceiling and every teaching error still applies. That is why the plugin
 * does not trust the child's self-report: it compares store revisions across the
 * run instead.
 *
 * @module deepseek-memory/subagent
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolRestriction } from '@deepseek-ai/dsh-tools';
import type { ObjectJsonSchema } from './define.ts';
import type { MemoryRuntime } from './runtime.ts';
import type { MemoryTier } from './store.ts';
/** Names of the tools this plugin registers. The child is filtered to exactly these. */
export declare const MEMORY_TOOL_NAMES: readonly ["memory_add", "memory_update", "memory_delete", "memory_list", "memory_search", "memory_status"];
/**
 * The slice of `SubagentRuntime` this plugin uses.
 *
 * Declared structurally and deliberately narrow. The plugin depends on one method
 * with one documented request shape, so it needs neither a hard dependency on the
 * subagent package nor the ability to configure anything else about the child.
 * `subagent-types.ts` asserts that the real service satisfies this.
 */
export interface SubagentConsolidator {
    /**
     * Establish a published child on the named provider.
     * @param name - the registered provider name.
     * @param request - label, prompt, parent, signal, and the optional narrowing knobs.
     * @returns the published run, whose result settles when the child finishes.
     */
    start(name: string, request: SubagentStartLike): Promise<SubagentRunLike>;
}
/** The request fields this plugin sets. Mirrors `SubagentStartRequest`. */
export interface SubagentStartLike {
    readonly label?: string;
    /**
     * Mutable array, matching `SubagentStartRequest.prompt` exactly. Declaring it
     * `readonly` reads better but makes this interface *narrower* in the wrong
     * direction: a function accepting the real request would then not accept this
     * one, and the conformance check in `typecheck.ts` fails.
     */
    readonly prompt: ContentBlock[];
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly toolFilter?: ToolRestriction;
    readonly persona?: string;
    readonly outputSchema?: ObjectJsonSchema;
}
/** The run handle this plugin uses. Mirrors `SubagentRun`. */
export interface SubagentRunLike {
    readonly result: Promise<{
        readonly stopReason: string;
        readonly structured?: unknown;
        readonly diagnostic?: string;
    }>;
    dispose(): void | Promise<void>;
}
/**
 * The child's required report shape.
 *
 * Deliberately minimal: the child is asked what it *did*, not to restate the
 * store. The authoritative record is the store itself, which the plugin reads
 * before and after the run.
 */
export declare const CONSOLIDATION_OUTPUT_SCHEMA: ObjectJsonSchema;
/** The child's persona, replacing the deployment persona for this child alone. */
export declare const CONSOLIDATOR_PERSONA = "You maintain a small long-term memory store for an AI coding assistant. You are not the assistant the user was talking to: you have no task of your own except keeping memory accurate.\n\nDecide whether anything in the turn you are shown is worth remembering long-term, and use the memory tools to apply exactly those changes.\n\nRules:\n- Memory holds durable facts: who the user is, standing preferences, project conventions, decisions, and constraints worth not rediscovering.\n- Never store transient task state, file contents, code, command output, secrets, tokens, or anything the user asked to forget.\n- Prefer few, high-value entries. Most turns deserve no change at all.\n- One fact per entry, at most a sentence or two.\n- Use memory_update when a fact changed or an existing entry is wrong; memory_delete when an entry is obsolete and nothing replaces it; memory_add only for genuinely new facts.\n- \"project\" is for this repository's conventions; \"user\" is for facts about the person.\n- Call memory_list first if you need the current entries and their ids.\n- You have no other tools. If a change needs the filesystem or a command, it does not belong in memory.\n\nWhen you are done, report what you changed.";
/**
 * What one child run did.
 */
export interface ChildConsolidationOutcome {
    /** Whether the child ran to a completed stop reason. */
    readonly completed: boolean;
    /** The child's own one-line account, when it produced one. */
    readonly summary: string;
    /** Whether the child claimed a change. */
    readonly claimedChange: boolean;
    /** Store revisions before and after, which is what the plugin actually trusts. */
    readonly revisionBefore: number;
    readonly revisionAfter: number;
    /** Whether the store actually moved. */
    readonly changed: boolean;
    /** Provider diagnostic for a non-completed run. */
    readonly diagnostic?: string;
}
/**
 * Run one consolidation as a restricted child agent.
 *
 * @param deps - the subagent service, the store owner, and logging.
 * @param input - the child's prompt material and the spawning agent.
 * @returns what the child did, including whether the store actually moved.
 */
export declare function runChildConsolidation(deps: {
    readonly subagents: SubagentConsolidator;
    readonly provider: string;
    readonly runtime: MemoryRuntime;
    readonly log: (message: string) => void;
    readonly warn: (message: string) => void;
}, input: {
    readonly parent: Agent;
    readonly transcript: string;
    readonly signal: AbortSignal;
}): Promise<ChildConsolidationOutcome>;
/** Which tiers participated, for diagnostics. */
export declare function tiersUsed(runtime: MemoryRuntime): MemoryTier[];
//# sourceMappingURL=subagent.d.ts.map
