import { TIER_SCOPES } from "./store.js";
/** Read-side precedence rank; lower wins. `session` outranks everything but is never persisted. */
export const SCOPE_PRECEDENCE = {
    session: 0,
    project: 1,
    'personal-topic': 2,
    'personal-global': 3,
    imported: 4,
};
/** Trust rank inside one scope; lower wins. */
const CONFIDENCE_PRECEDENCE = {
    'user-confirmed': 0,
    high: 1,
    medium: 2,
    low: 3,
};
/**
 * Which scopes a reader can see at all.
 *
 * `session` is never persisted; `imported` is filtered earlier with its own
 * reason. `context.subjects` narrows individual `personal-topic` cards per
 * group below — the scope itself is always readable, the subject gates it.
 */
const READABLE_SCOPES = new Set(['project', 'personal-global', 'personal-topic']);
/** Whether one card is visible to a reader in this context. */
function isReadable(entry, context) {
    if (!READABLE_SCOPES.has(entry.scope))
        return false;
    if (entry.scope === 'personal-topic') {
        if (context.subjects === undefined || context.subjects.length === 0)
            return false;
        const inPlay = new Set(context.subjects.map(subject => subject.trim().toLowerCase()).filter(subject => subject !== ''));
        return inPlay.has(entry.subject.trim().toLowerCase());
    }
    return true;
}
/**
 * Decide which card in one competing set wins.
 *
 * Extracted so the tie-break order lives in exactly one place: scope rank,
 * then confidence rank, then recency, then a stable id comparison so the
 * outcome is deterministic and testable.
 */
function pickWinner(candidates) {
    let winner = candidates[0];
    let decidedBy = 'recency';
    for (const candidate of candidates.slice(1)) {
        const scopeDelta = SCOPE_PRECEDENCE[candidate.scope] - SCOPE_PRECEDENCE[winner.scope];
        if (scopeDelta < 0) {
            winner = candidate;
            decidedBy = 'scope';
            continue;
        }
        if (scopeDelta > 0)
            continue;
        const confidenceDelta = CONFIDENCE_PRECEDENCE[candidate.confidence] - CONFIDENCE_PRECEDENCE[winner.confidence];
        if (confidenceDelta < 0) {
            winner = candidate;
            decidedBy = 'confidence';
            continue;
        }
        if (confidenceDelta > 0)
            continue;
        if (candidate.updatedAt > winner.updatedAt) {
            winner = candidate;
            decidedBy = 'recency';
        }
    }
    return { winner, decidedBy };
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
export function resolveEffective(entries, context = {}) {
    const excluded = [];
    const candidates = [];
    for (const entry of entries) {
        if (entry.scope === 'imported') {
            excluded.push({ entry, reason: 'imported' });
            continue;
        }
        if (entry.status === 'superseded' || entry.status === 'archived') {
            excluded.push({ entry, reason: 'status' });
            continue;
        }
        if (!isReadable(entry, context)) {
            excluded.push({
                entry,
                reason: entry.scope === 'personal-topic' ? 'subject-not-in-play' : 'scope-not-readable',
            });
            continue;
        }
        candidates.push(entry);
    }
    const byGroup = new Map();
    for (const entry of candidates) {
        // The \u0001 separator cannot appear in a normalized label, so two distinct
        // (subject, key) pairs can never collide onto one group key.
        const groupKey = `${entry.subject.trim().toLowerCase()}\u0001${entry.key.trim().toLowerCase()}`;
        const bucket = byGroup.get(groupKey);
        if (bucket === undefined)
            byGroup.set(groupKey, [entry]);
        else
            bucket.push(entry);
    }
    const groups = [];
    for (const bucket of byGroup.values()) {
        const { winner, decidedBy } = pickWinner(bucket);
        groups.push({
            subject: winner.subject,
            key: winner.key,
            effective: winner,
            decidedBy,
            shadowed: bucket.filter(entry => entry.id !== winner.id),
        });
    }
    groups.sort((left, right) => SCOPE_PRECEDENCE[left.effective.scope] - SCOPE_PRECEDENCE[right.effective.scope]);
    return { groups, excluded };
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
export function detectScopeViolation(entry, tier) {
    return !TIER_SCOPES[tier].includes(entry.scope);
}
/** Every card in a store that violates its tier's scope remit, for the arbitration view. */
export function findScopeViolations(entries, tier) {
    return entries.filter(entry => detectScopeViolation(entry, tier));
}
//# sourceMappingURL=scope.js.map