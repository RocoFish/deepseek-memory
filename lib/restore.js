import { MemoryError } from "./store.js";
import { createSnapshot } from "./snapshot.js";
/** Which parts of a card matter for "did it change". */
function cardDiffers(left, right) {
    return left.text !== right.text
        || left.status !== right.status
        || left.confidence !== right.confidence
        || left.scope !== right.scope
        || left.subject !== right.subject
        || left.key !== right.key
        || left.tags.length !== right.tags.length
        || left.tags.some((tag, index) => tag !== right.tags[index])
        || left.supersedes.length !== right.supersedes.length
        || left.supersedes.some((id, index) => id !== right.supersedes[index]);
}
/**
 * Diff one snapshot against the current on-disk state.
 *
 * Only tiers the snapshot actually captured are compared; a tier that appears
 * later (or was disabled at snapshot time) is out of scope for this restore.
 */
export function diffRestore(snapshot, current) {
    const tiers = [];
    for (const [tierName, snapshotStore] of Object.entries(snapshot.tiers)) {
        const tier = tierName;
        const currentStore = current[tier];
        const snapshotById = new Map(snapshotStore.entries.map(entry => [entry.id, entry]));
        const currentById = new Map((currentStore?.entries ?? []).map(entry => [entry.id, entry]));
        const added = [];
        const removed = [];
        const modified = [];
        const conflicts = [];
        let unchanged = 0;
        for (const entry of snapshotStore.entries) {
            const live = currentById.get(entry.id);
            if (live === undefined) {
                added.push(entry);
                continue;
            }
            if (!cardDiffers(entry, live)) {
                unchanged += 1;
                continue;
            }
            // The current card moved after the snapshot was taken: its edits are
            // work the snapshot never saw, so overwriting it is a conflict, not a
            // modification.
            if (live.updatedAt > snapshot.createdAt) {
                conflicts.push({ id: entry.id, current: live, snapshot: entry });
            }
            else {
                modified.push(entry);
            }
        }
        for (const entry of currentStore?.entries ?? []) {
            if (!snapshotById.has(entry.id))
                removed.push(entry);
        }
        tiers.push({ tier, added, removed, modified, conflicts, unchanged });
    }
    return { snapshotId: snapshot.id, snapshotCreatedAt: snapshot.createdAt, tiers };
}
/**
 * Apply confirmed selections from one snapshot.
 *
 * Order is the contract: the current library is backed up as `pre-restore`
 * **before** any mutation lands, every mutation goes through the store's
 * revisioned write paths, and only tiers that received a confirmed selection
 * are committed. Unconfirmed entries — conflicts above all — are untouched.
 *
 * @returns what changed, and the pre-restore backup id.
 */
export function applyRestore(runtime, snapshot, selections, now = Date.now()) {
    if (selections.length === 0) {
        throw new MemoryError('restore needs at least one confirmed selection; run memory_restore with action "preview" first and pick the entries to apply.', 'MEMORY_RESTORE_NO_SELECTION');
    }
    const byTier = new Map();
    for (const selection of selections) {
        const bucket = byTier.get(selection.tier);
        if (bucket === undefined)
            byTier.set(selection.tier, [selection]);
        else
            bucket.push(selection);
    }
    // Backup first. This refreshes the runtime, so the stores loaded below are
    // the on-disk truth the diff was computed against.
    const backup = createSnapshot(runtime, 'pre-restore', `restore:${snapshot.id}`, now);
    runtime.refresh();
    const touched = [];
    for (const [tier, tierSelections] of byTier) {
        const store = runtime.store(tier);
        const snapshotEntries = new Map((snapshot.tiers[tier]?.entries ?? []).map(entry => [entry.id, entry]));
        let added = 0;
        let removed = 0;
        let modified = 0;
        for (const selection of tierSelections) {
            if (selection.direction === 'remove') {
                store.remove(selection.id, now);
                removed += 1;
                continue;
            }
            const entry = snapshotEntries.get(selection.id);
            if (entry === undefined) {
                throw new MemoryError(`snapshot ${snapshot.id} holds no ${selection.id} in the ${tier} tier; refusing to restore an entry it never captured.`, 'MEMORY_RESTORE_NOT_IN_SNAPSHOT');
            }
            store.upsertRestored(entry);
            if (selection.direction === 'add')
                added += 1;
            else
                modified += 1;
        }
        runtime.commit(tier, store);
        touched.push({ tier, added, removed, modified });
    }
    return { preRestoreId: backup.id, touched };
}
