/**
 * The arbitration console: one read-only view over every card in every tier,
 * grouped by (subject, key), with the losing and pending cards kept visible.
 *
 * The design contract, fixed before any code was written:
 *
 * - The system **reports**, never silently decides. Every group shows which
 *   value is in force and *why* (scope hit, confidence, recency), which cards
 *   lost, and which cards are waiting on a human (imported, low-confidence,
 *   disputed).
 * - Nothing is deleted by arbitration. Losers are demoted to `superseded`
 *   and stay on disk so any decision can be replayed later.
 * - The view is cross-tier on purpose: the interesting conflicts are exactly
 *   the ones that span layers (a project rule shadowing a global preference),
 *   and a per-tier list cannot show them.
 *
 * @module deepseek-memory/arbitrate
 */
import type { ResolutionContext } from './scope.ts';
import type { MemoryEntry, MemoryTier } from './store.ts';
/** One card together with the tier that holds it. */
export interface TieredEntry {
    readonly tier: MemoryTier;
    readonly entry: MemoryEntry;
}
/** Which layer of the arbitration view a card sits in. */
export type ArbitrationLayer = 'effective' | 'shadowed' | 'pending';
/**
 * Why a card outside the clean in-force/shadowed picture needs attention.
 *
 * - `scope-violation` — the card sits in a tier that has no business holding
 *   its scope (a personal card in the project store, or vice versa).
 * - `imported` — an imported card that no live group claims; it cannot affect
 *   anything until the user confirms it into a real scope.
 * - `low-confidence` — an active/disputed card whose only support is a weak
 *   inference; it is in force but should not be without confirmation.
 */
export type ArbitrationFlag = 'scope-violation' | 'imported' | 'low-confidence';
/** One card in one group of the view. */
export interface ArbitrationCard {
    readonly tier: MemoryTier;
    readonly entry: MemoryEntry;
    readonly layer: ArbitrationLayer;
    /** Set when the effective card is disputed — the group needs a ruling. */
    readonly disputed: boolean;
}
/** One (subject, key) group: the in-force value, what it beat, what waits. */
export interface ArbitrationGroup {
    readonly subject: string;
    readonly key: string;
    /** Why the effective card won; absent only when the group has one card. */
    readonly decidedBy: 'scope' | 'confidence' | 'recency' | undefined;
    /** Effective first, then shadowed, then pending. */
    readonly cards: readonly ArbitrationCard[];
}
/** One card that needs attention without belonging to a competing group. */
export interface ArbitrationFlagged {
    readonly tier: MemoryTier;
    readonly entry: MemoryEntry;
    readonly reason: ArbitrationFlag;
}
/** The whole console: competing groups, flagged cards, and honest counts. */
export interface ArbitrationView {
    readonly groups: readonly ArbitrationGroup[];
    readonly flagged: readonly ArbitrationFlagged[];
    readonly stats: {
        readonly total: number;
        readonly active: number;
        readonly disputed: number;
        readonly superseded: number;
        readonly archived: number;
        readonly imported: number;
        readonly violations: number;
    };
}
/**
 * Build the read-only arbitration view over every card in every tier.
 *
 * Resolution (which value is in force) runs exactly as it does for injection —
 * same precedence, same grouping — so the console can never disagree with what
 * the model actually saw. On top of the resolved groups it layers the things
 * resolution deliberately ignores: tier scope violations, unclaimed imported
 * cards, and weakly-supported in-force cards.
 *
 * @param tiered - every card from every enabled tier, each with its tier.
 * @param context - what the current session is about; gates personal-topic cards.
 */
export declare function buildArbitrationView(tiered: readonly TieredEntry[], context?: ResolutionContext): ArbitrationView;
/**
 * Find every live competitor of the card being adopted: the readable,
 * active-or-disputed cards that share its (subject, key), minus the winner.
 *
 * Cross-tier on purpose — adopting the project value demotes the global card
 * it was shadowing, and the demotion must be written to the store that
 * actually holds the loser.
 */
export declare function competingCards(winner: MemoryEntry, candidates: readonly TieredEntry[]): TieredEntry[];
//# sourceMappingURL=arbitrate.d.ts.map
