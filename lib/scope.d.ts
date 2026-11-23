/**
 * Scope rules: where a memory lives, and which value wins when two cards
 * answer the same question.
 *
 * The system never arbitrates silently. `resolveEffective` reports which card
 * wins *and why* (scope hit, confidence, confirmation); anything it demotes is
 * returned alongside, never dropped, so the arbitration view can replay the
 * decision later.
 *
 * Precedence, highest first:
 *
 * 1. the current session's explicit instruction (never persisted)
 * 2. `project` — this repository's conventions
 * 3. `personal-topic` — personal facts about the subjects in play
 * 4. `personal-global` — standing personal facts
 * 5. `imported` — never affects answers on its own; only after the user
 *    confirms it into a real scope does it count
 *
 * Inside one scope, `user-confirmed` beats inference regardless of age, and
 * only then does recency break the tie. A card written by the assistant from
 * the user's own words is still the user's information — `source` records
 * provenance, `confidence` records trust, and the two never overwrite each
 * other.
 *
 * @module deepseek-memory/scope
 */
import type { MemoryEntry, MemoryScope, MemoryTier } from './store.ts';
/** Read-side precedence rank; lower wins. `session` outranks everything but is never persisted. */
export declare const SCOPE_PRECEDENCE: Readonly<Record<MemoryScope, number>>;
/** The subjects a session is about; gates which `personal-topic` cards are readable. */
export interface ResolutionContext {
    /** Subjects in play, e.g. ['deepseek-memory', 'math-modeling']. Matched case-insensitively. */
    readonly subjects?: readonly string[];
}
/** One (subject, key) group after resolution. */
export interface ResolvedGroup {
    readonly subject: string;
    readonly key: string;
    /** The card whose value is in force, with the reason it won. */
    readonly effective: MemoryEntry;
    /** Why this card won: scope rank, confidence rank, or recency. */
    readonly decidedBy: 'scope' | 'confidence' | 'recency';
    /** Cards that lost, kept for the arbitration view; never deleted by resolution. */
    readonly shadowed: readonly MemoryEntry[];
}
export interface ResolutionResult {
    /** Groups with a value in force, best scope first. */
    readonly groups: readonly ResolvedGroup[];
    /** Cards excluded before grouping, each with its reason. */
    readonly excluded: readonly {
        entry: MemoryEntry;
        reason: 'status' | 'scope-not-readable' | 'subject-not-in-play' | 'imported';
    }[];
}
/**
 * Resolve every readable card into (subject, key) groups and decide which
 * value of each group is in force.
 *
 * Imported cards never participate: they are excluded with reason `imported`,
 * visible in the report but unable to affect any answer until the user
 * confirms them into a real scope through the arbitration view.
 *
 * @param entries - every card from every readable store, tier already applied.
 * @param context - what the current session is about.
 */
export declare function resolveEffective(entries: readonly MemoryEntry[], context?: ResolutionContext): ResolutionResult;
/**
 * Detect a card stored in a tier that has no business holding it.
 *
 * The two concrete cases: a personal card (`personal-*`) found in a
 * project-tier store — a write that escaped the project directory's remit —
 * and a `project` card found in the user-tier store, which would leak one
 * repository's conventions into every session. `session` and `imported` are
 * unwritable through normal paths, so a persisted one is itself a violation.
 */
export declare function detectScopeViolation(entry: MemoryEntry, tier: MemoryTier): boolean;
/** Every card in a store that violates its tier's scope remit, for the arbitration view. */
export declare function findScopeViolations(entries: readonly MemoryEntry[], tier: MemoryTier): MemoryEntry[];
