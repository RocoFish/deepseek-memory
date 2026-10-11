/**
 * The injected memory section.
 *
 * This is a `systemPrompt` section whose `text` is a *provider*, so it is
 * recomputed at every assembly. That matters: a durable injected message would
 * leave a stale snapshot in session history and keep being replayed after the
 * underlying memory changed, while a provider cannot drift.
 *
 * The section is also deliberately honest about what it is. Memory entries are
 * notes written in earlier sessions; the model must not treat them as current
 * instructions, and it must know which tier said what so it can weight a
 * project convention against a personal preference.
 *
 * @module deepseek-memory/prompt
 */
import type { MemoryEntry, MemoryTier } from './store.ts';
/** Section placement. Late enough to follow harness guidance, early enough to precede tool schemas. */
export declare const MEMORY_SECTION_ORDER = 60;
/** The stable section name. A duplicate registration throws, so it must be unique. */
export declare const MEMORY_SECTION = "memory";
/** One tier's contribution to an assembly. */
export interface TierView {
    readonly tier: MemoryTier;
    /** A short human label for the tier, used as the section heading. */
    readonly label: string;
    readonly entries: readonly MemoryEntry[];
}
/** What the injector rendered, for tests and for the stats tool. */
export interface RenderedMemory {
    /** The complete section text, empty when there is nothing worth injecting. */
    readonly text: string;
    /** Entries that made it inside the budget, in injection order. */
    readonly injected: readonly MemoryEntry[];
    /** Entries dropped because the budget ran out. */
    readonly omitted: number;
    /** Whether the budget forced any omission. */
    readonly truncated: boolean;
}
/**
 * Render the memory section.
 *
 * Project-tier entries come first: a repository's conventions outrank a personal
 * habit when the two compete for the same budget, and the budget is the binding
 * constraint that keeps this section from growing without bound.
 *
 * @param tiers - the enabled tiers, in priority order.
 * @param budgetChars - maximum characters of entry text to include.
 * @returns the section text and what it contains.
 */
export declare function renderMemory(tiers: readonly TierView[], budgetChars: number): RenderedMemory;
//# sourceMappingURL=prompt.d.ts.map