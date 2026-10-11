/**
 * The cheap gate that decides whether a closed turn is worth consolidating.
 *
 * The expensive part of memory maintenance is the model call that reads a turn
 * and rewrites the store. Paying it after every turn is faithful but wasteful:
 * most turns contain nothing durable. This gate is a local, allocation-light,
 * fully deterministic scan for the handful of situations that actually change
 * long-term memory, so the model call happens only when it can pay for itself.
 *
 * Being a heuristic, it is deliberately biased toward **under**-triggering: a
 * missed consolidation is repaired by the next related turn, whereas an eager
 * consolidator that runs on chatter eventually starts inventing memories.
 *
 * @module deepseek-memory/gate
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm';
/** One recognized reason a turn may deserve consolidation. */
export interface GateSignal {
    /** Stable discriminant, also used in logs. */
    readonly kind: string;
    /** The matched phrase, for explaining the decision. */
    readonly evidence: string;
    /** Relative importance; the highest matching signal decides. */
    readonly weight: number;
}
/** The gate's verdict for one closed turn. */
export interface GateDecision {
    /** Whether the consolidator should run. */
    readonly run: boolean;
    /** Why, best signal first. */
    readonly signals: readonly GateSignal[];
}
/** Messages the gate inspects. Assistant text counts, tool output does not. */
export interface GateInput {
    /** Every user-role message that entered the turn, in order. */
    readonly userMessages: readonly UserMessage[];
    /** The assistant's own final text for the turn, when available. */
    readonly assistantText?: string;
}
/**
 * Evaluate one closed turn.
 *
 * @param input - the turn's user messages and optional assistant text.
 * @returns whether to consolidate, and the signals that decided it.
 */
export declare function evaluateGate(input: GateInput): GateDecision;
/** One-line explanation for logs, so a skipped or taken run is auditable. */
export declare function describeDecision(decision: GateDecision): string;
//# sourceMappingURL=gate.d.ts.map