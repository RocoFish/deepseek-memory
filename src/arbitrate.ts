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
import type { ResolutionContext } from './scope.ts'
import { detectScopeViolation, resolveEffective } from './scope.ts'
import type { MemoryEntry, MemoryTier } from './store.ts'

/** One card together with the tier that holds it. */
export interface TieredEntry {
  readonly tier: MemoryTier
  readonly entry: MemoryEntry
}

/** Which layer of the arbitration view a card sits in. */
export type ArbitrationLayer = 'effective' | 'shadowed' | 'pending'

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
export type ArbitrationFlag = 'scope-violation' | 'imported' | 'low-confidence'

/** One card in one group of the view. */
export interface ArbitrationCard {
  readonly tier: MemoryTier
  readonly entry: MemoryEntry
  readonly layer: ArbitrationLayer
  /** Set when the effective card is disputed — the group needs a ruling. */
  readonly disputed: boolean
}

/** One (subject, key) group: the in-force value, what it beat, what waits. */
export interface ArbitrationGroup {
  readonly subject: string
  readonly key: string
  /** Why the effective card won; absent only when the group has one card. */
  readonly decidedBy: 'scope' | 'confidence' | 'recency' | undefined
  /** Effective first, then shadowed, then pending. */
  readonly cards: readonly ArbitrationCard[]
}

/** One card that needs attention without belonging to a competing group. */
export interface ArbitrationFlagged {
  readonly tier: MemoryTier
  readonly entry: MemoryEntry
  readonly reason: ArbitrationFlag
}

/** The whole console: competing groups, flagged cards, and honest counts. */
export interface ArbitrationView {
  readonly groups: readonly ArbitrationGroup[]
  readonly flagged: readonly ArbitrationFlagged[]
  readonly stats: {
    readonly total: number
    readonly active: number
    readonly disputed: number
    readonly superseded: number
    readonly archived: number
    readonly imported: number
    readonly violations: number
  }
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
export function buildArbitrationView(
  tiered: readonly TieredEntry[],
  context: ResolutionContext = {},
): ArbitrationView {
  const tierById = new Map<string, MemoryTier>()
  for (const { tier, entry } of tiered) tierById.set(entry.id, tier)

  const { groups, excluded } = resolveEffective(
    tiered.map(({ entry }) => entry),
    context,
  )

  const arbitrationGroups: ArbitrationGroup[] = groups.map((group) => {
    const cards: ArbitrationCard[] = [
      {
        tier: tierById.get(group.effective.id) ?? 'user',
        entry: group.effective,
        layer: 'effective',
        disputed: group.effective.status === 'disputed',
      },
      ...group.shadowed.map((entry): ArbitrationCard => ({
        tier: tierById.get(entry.id) ?? 'user',
        entry,
        layer: 'shadowed',
        disputed: entry.status === 'disputed',
      })),
    ]
    return {
      subject: group.effective.subject,
      key: group.effective.key,
      decidedBy: group.shadowed.length > 0 ? group.decidedBy : undefined,
      cards,
    }
  })

  const flagged: ArbitrationFlagged[] = []
  const groupKeys = new Set(
    arbitrationGroups.map(group => `${group.subject.trim().toLowerCase()}\u0001${group.key.trim().toLowerCase()}`),
  )
  for (const { entry, reason } of excluded) {
    if (reason === 'status') continue
    if (reason === 'imported') {
      // An imported card that shares a live group's (subject, key) is shown as
      // that group's pending layer; an unclaimed one is flagged on its own.
      const claimed = groupKeys.has(`${entry.subject.trim().toLowerCase()}\u0001${entry.key.trim().toLowerCase()}`)
      if (claimed) {
        const group = arbitrationGroups.find(candidate =>
          candidate.subject.trim().toLowerCase() === entry.subject.trim().toLowerCase()
          && candidate.key.trim().toLowerCase() === entry.key.trim().toLowerCase())
        if (group !== undefined) {
          ;(group.cards as ArbitrationCard[]).push({
            tier: tierById.get(entry.id) ?? 'user',
            entry,
            layer: 'pending',
            disputed: false,
          })
        }
        continue
      }
      flagged.push({ tier: tierById.get(entry.id) ?? 'user', entry, reason: 'imported' })
      continue
    }
    // subject-not-in-play cards are invisible by rule, not by problem; the
    // console is about conflicts, so they are simply omitted here.
  }

  let active = 0
  let disputed = 0
  let superseded = 0
  let archived = 0
  let imported = 0
  let violations = 0
  for (const { tier, entry } of tiered) {
    switch (entry.status) {
      case 'active': active += 1; break
      case 'disputed': disputed += 1; break
      case 'superseded': superseded += 1; break
      case 'archived': archived += 1; break
    }
    if (entry.scope === 'imported') imported += 1
    if (detectScopeViolation(entry, tier)) violations += 1
  }

  // Active or disputed cards that won nothing and are only weakly supported:
  // they are in force somewhere but should not stay that way unconfirmed. Only
  // cards not already in a group are flagged — in-group weakness shows as the
  // group itself, with the decidedBy reason explaining the win.
  const groupedIds = new Set(arbitrationGroups.flatMap(group => group.cards.map(card => card.entry.id)))
  // Tier violations are about *where a card lives*, not which group it belongs
  // to: a personal card that escaped into the project store competes normally
  // and is still flagged as misplaced. Flagged once per card, in stable order.
  for (const { tier, entry } of tiered) {
    if (detectScopeViolation(entry, tier)) flagged.push({ tier, entry, reason: 'scope-violation' })
  }
  for (const { tier, entry } of tiered) {
    if (groupedIds.has(entry.id)) continue
    if (entry.status !== 'active' && entry.status !== 'disputed') continue
    if (entry.scope === 'imported') continue
    if (entry.confidence === 'low') flagged.push({ tier, entry, reason: 'low-confidence' })
  }

  return {
    groups: arbitrationGroups,
    flagged,
    stats: { total: tiered.length, active, disputed, superseded, archived, imported, violations },
  }
}

/**
 * Find every live competitor of the card being adopted: the readable,
 * active-or-disputed cards that share its (subject, key), minus the winner.
 *
 * Cross-tier on purpose — adopting the project value demotes the global card
 * it was shadowing, and the demotion must be written to the store that
 * actually holds the loser.
 */
export function competingCards(winner: MemoryEntry, candidates: readonly TieredEntry[]): TieredEntry[] {
  const subject = winner.subject.trim().toLowerCase()
  const key = winner.key.trim().toLowerCase()
  return candidates.filter(({ entry }) =>
    entry.id !== winner.id
    && entry.status !== 'superseded'
    && entry.status !== 'archived'
    && entry.scope !== 'imported'
    && entry.subject.trim().toLowerCase() === subject
    && entry.key.trim().toLowerCase() === key)
}
