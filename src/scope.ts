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
import type { MemoryEntry, MemoryScope, MemoryTier } from './store.ts'
import { TIER_SCOPES } from './store.ts'

/** Read-side precedence rank; lower wins. `session` outranks everything but is never persisted. */
export const SCOPE_PRECEDENCE: Readonly<Record<MemoryScope, number>> = {
  session: 0,
  project: 1,
  'personal-topic': 2,
  'personal-global': 3,
  imported: 4,
}

/** Trust rank inside one scope; lower wins. */
const CONFIDENCE_PRECEDENCE: Readonly<Record<MemoryEntry['confidence'], number>> = {
  'user-confirmed': 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** The subjects a session is about; gates which `personal-topic` cards are readable. */
export interface ResolutionContext {
  /** Subjects in play, e.g. ['deepseek-memory', 'math-modeling']. Matched case-insensitively. */
  readonly subjects?: readonly string[]
}

/** One (subject, key) group after resolution. */
export interface ResolvedGroup {
  readonly subject: string
  readonly key: string
  /** The card whose value is in force, with the reason it won. */
  readonly effective: MemoryEntry
  /** Why this card won: scope rank, confidence rank, or recency. */
  readonly decidedBy: 'scope' | 'confidence' | 'recency'
  /** Cards that lost, kept for the arbitration view; never deleted by resolution. */
  readonly shadowed: readonly MemoryEntry[]
}

export interface ResolutionResult {
  /** Groups with a value in force, best scope first. */
  readonly groups: readonly ResolvedGroup[]
  /** Cards excluded before grouping, each with its reason. */
  readonly excluded: readonly { entry: MemoryEntry; reason: 'status' | 'scope-not-readable' | 'subject-not-in-play' | 'imported' }[]
}

/**
 * Which scopes a reader can see at all.
 *
 * `session` is never persisted; `imported` is filtered earlier with its own
 * reason. `context.subjects` narrows individual `personal-topic` cards per
 * group below — the scope itself is always readable, the subject gates it.
 */
const READABLE_SCOPES: ReadonlySet<MemoryScope> = new Set(['project', 'personal-global', 'personal-topic'])

/** Whether one card is visible to a reader in this context. */
function isReadable(entry: MemoryEntry, context: ResolutionContext): boolean {
  if (!READABLE_SCOPES.has(entry.scope)) return false
  if (entry.scope === 'personal-topic') {
    if (context.subjects === undefined || context.subjects.length === 0) return false
    const inPlay = new Set(context.subjects.map(subject => subject.trim().toLowerCase()).filter(subject => subject !== ''))
    return inPlay.has(entry.subject.trim().toLowerCase())
  }
  return true
}

/**
 * Decide which card in one competing set wins.
 *
 * Extracted so the tie-break order lives in exactly one place: scope rank,
 * then confidence rank, then recency, then a stable id comparison so the
 * outcome is deterministic and testable.
 */
function pickWinner(candidates: readonly MemoryEntry[]): { winner: MemoryEntry; decidedBy: 'scope' | 'confidence' | 'recency' } {
  let winner = candidates[0]!
  let decidedBy: 'scope' | 'confidence' | 'recency' = 'recency'
  for (const candidate of candidates.slice(1)) {
    const scopeDelta = SCOPE_PRECEDENCE[candidate.scope] - SCOPE_PRECEDENCE[winner.scope]
    if (scopeDelta < 0) {
      winner = candidate
      decidedBy = 'scope'
      continue
    }
    if (scopeDelta > 0) continue
    const confidenceDelta = CONFIDENCE_PRECEDENCE[candidate.confidence] - CONFIDENCE_PRECEDENCE[winner.confidence]
    if (confidenceDelta < 0) {
      winner = candidate
      decidedBy = 'confidence'
      continue
    }
    if (confidenceDelta > 0) continue
    if (candidate.updatedAt > winner.updatedAt) {
      winner = candidate
      decidedBy = 'recency'
    }
  }
  return { winner, decidedBy }
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
export function resolveEffective(entries: readonly MemoryEntry[], context: ResolutionContext = {}): ResolutionResult {
  const excluded: { entry: MemoryEntry; reason: 'status' | 'scope-not-readable' | 'subject-not-in-play' | 'imported' }[] = []
  const candidates: MemoryEntry[] = []
  for (const entry of entries) {
    if (entry.scope === 'imported') {
      excluded.push({ entry, reason: 'imported' })
      continue
    }
    if (entry.status === 'superseded' || entry.status === 'archived') {
      excluded.push({ entry, reason: 'status' })
      continue
    }
    if (!isReadable(entry, context)) {
      excluded.push({
        entry,
        reason: entry.scope === 'personal-topic' ? 'subject-not-in-play' : 'scope-not-readable',
      })
      continue
    }
    candidates.push(entry)
  }

  const byGroup = new Map<string, MemoryEntry[]>()
  for (const entry of candidates) {
    const groupKey = `${entry.subject.trim().toLowerCase()} ${entry.key.trim().toLowerCase()}`
    const bucket = byGroup.get(groupKey)
    if (bucket === undefined) byGroup.set(groupKey, [entry])
    else bucket.push(entry)
  }

  const groups: ResolvedGroup[] = []
  for (const bucket of byGroup.values()) {
    const { winner, decidedBy } = pickWinner(bucket)
    groups.push({
      subject: winner.subject,
      key: winner.key,
      effective: winner,
      decidedBy,
      shadowed: bucket.filter(entry => entry.id !== winner.id),
    })
  }
  groups.sort((left, right) => SCOPE_PRECEDENCE[left.effective.scope] - SCOPE_PRECEDENCE[right.effective.scope])
  return { groups, excluded }
}

/**
 * Detect a card stored in a tier that has no business holding it.
 *
 * The two concrete cases: a personal card (`personal-*`) found in a
 * project-tier store — a write that escaped the project directory's remit —
 * and a `project` card found in the user-tier store, which would leak one
 * repository's conventions into every session. `session` and `imported` are
 * unwritable through normal paths, so a persisted one is itself a violation.
 */
export function detectScopeViolation(entry: MemoryEntry, tier: MemoryTier): boolean {
  return !TIER_SCOPES[tier].includes(entry.scope)
}

/** Every card in a store that violates its tier's scope remit, for the arbitration view. */
export function findScopeViolations(entries: readonly MemoryEntry[], tier: MemoryTier): MemoryEntry[] {
  return entries.filter(entry => detectScopeViolation(entry, tier))
}
