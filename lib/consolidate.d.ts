/**
 * After-turn memory consolidation.
 *
 * The turn boundary this hooks is `agent/status` → `idle`, which is an `emit`:
 * the turn has already closed and nothing waits for us. That is deliberate —
 * `agent/turn-stopping` is serial and awaited, so consolidating there would add
 * model latency to every single turn.
 *
 * The consolidator proposes a **change set**, it does not write. The plugin
 * validates and applies that set atomically, which buys three things a model with
 * direct write access cannot give:
 *
 * - a malformed or hallucinated action can only fail its own proposal, never
 *   leave a half-applied store;
 * - the ceilings are re-checked against the real store rather than trusted;
 * - the exact applied set is logged, so a surprising memory can be traced to the
 *   run that wrote it.
 *
 * @module deepseek-memory/consolidate
 */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MemoryConfig } from './config.ts';
import { evaluateGate } from './gate.ts';
import type { MemoryRuntime } from './runtime.ts';
import { type MemoryTier } from './store.ts';
import { type SubagentConsolidator } from './subagent.ts';
/** Hard cap on proposals applied from one run, so one bad run cannot rewrite a whole store. */
export declare const MAX_ACTIONS_PER_RUN = 8;
/** Hard cap on the transcript characters handed to the consolidator. */
export declare const MAX_TRANSCRIPT_CHARS = 6000;
/** One proposed mutation from the consolidator. */
export type ProposedAction = {
    readonly op: 'add';
    readonly tier: MemoryTier;
    readonly text: string;
    readonly tags?: string[];
} | {
    readonly op: 'update';
    readonly tier: MemoryTier;
    readonly id: string;
    readonly text: string;
    readonly tags?: string[];
} | {
    readonly op: 'delete';
    readonly tier: MemoryTier;
    readonly id: string;
} | {
    readonly op: 'none';
};
/** What one consolidation run did, for logs and for tests. */
export interface ConsolidationOutcome {
    readonly ran: boolean;
    readonly reason: string;
    readonly applied: readonly string[];
    readonly rejected: readonly string[];
}
/**
 * Extract the JSON object from a model reply, tolerating a fenced block.
 * @returns the parsed value, or undefined when no object could be read.
 */
export declare function parseProposal(reply: string): unknown;
/** Validate one raw action into a typed proposal, or explain why it was refused. */
export declare function validateAction(raw: unknown): {
    action: ProposedAction;
} | {
    refusal: string;
};
/**
 * Apply a validated change set to one tier.
 *
 * All-or-nothing per tier: a refusal rolls that tier's in-memory changes back by
 * reloading from disk, so a partially valid proposal cannot leave a store in a
 * state the model did not propose.
 * @returns the applied descriptions and the refusals.
 */
export declare function applyActions(runtime: MemoryRuntime, actions: readonly ProposedAction[], now: number): {
    applied: string[];
    rejected: string[];
};
/** Gather the turn's text for the gate and the transcript, from session events. */
export interface TurnCapture {
    /** User-role messages that entered the turn, in order. */
    readonly userTexts: readonly string[];
    /** Assistant text produced during the turn, in order. */
    readonly assistantTexts: readonly string[];
}
/** Render a bounded transcript for the consolidator's single request. */
export declare function renderTranscript(capture: TurnCapture): string;
/** Everything the consolidator needs from the live runtime. */
export interface ConsolidatorDeps {
    readonly runtime: MemoryRuntime;
    readonly config: MemoryConfig;
    readonly llm: LlmRuntime | undefined;
    readonly model: {
        provider: string;
        model: string;
    } | undefined;
    /** Model-facing messages, so the gate can inspect the turn. */
    readonly toUserMessages: (texts: readonly string[]) => Parameters<typeof evaluateGate>[0]['userMessages'];
    readonly log: (message: string) => void;
    readonly warn: (message: string) => void;
    /**
     * The preferred consolidation path: a restricted child agent. Absent when the
     * deployment mounts no subagent provider, in which case the direct model request
     * is used instead.
     */
    readonly child?: {
        readonly subagents: SubagentConsolidator | undefined;
        /** Registered subagent provider name. */
        readonly provider: string;
        /** The spawning agent, required by the subagent seam. */
        readonly parent: Agent;
        /** Wall-clock cap for one child run, so a stuck child cannot hold the slot. */
        readonly timeoutMs: number;
    };
}
/**
 * Run one consolidation, if the gate agrees.
 *
 * Prefers the restricted child agent, which needs no extra model configuration
 * (the child inherits the parent's route), gets its own context, and cannot reach
 * anything but the memory tools. Falls back to a direct model request when no
 * subagent provider is mounted, so a deployment without one still consolidates.
 *
 * @param deps - live services.
 * @param capture - the closed turn's text.
 * @param signal - cancellation from the turn that just closed, when still live.
 * @returns what happened, including the reason when nothing ran.
 */
export declare function consolidateTurn(deps: ConsolidatorDeps, capture: TurnCapture, signal?: AbortSignal): Promise<ConsolidationOutcome>;
//# sourceMappingURL=consolidate.d.ts.map