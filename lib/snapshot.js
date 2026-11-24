/**
 * Snapshots: named, restorable points-in-time of the whole memory library.
 *
 * Three properties are deliberate:
 *
 * 1. **A snapshot captures on-disk truth.** Creation refreshes the runtime
 *    cache and reads the files from disk, so it can never immortalize a stale
 *    in-memory state that a crashed session would have lost anyway.
 * 2. **Snapshots live outside the tiers they capture.** The project tier is
 *    designed to be committed to a repository; burying backups in it would
 *    pollute the repo and leak personal-tier data into a shared tree. The
 *    snapshot directory therefore sits in the user tier, with the project
 *    tier as fallback for deployments that have no user tier.
 * 3. **Retention is per-kind.** Pre-operation snapshots are frequent and
 *    short-lived; dailies cover slow drift; weeklies cover late discovery.
 *    Each kind keeps its own bound so one chatty kind cannot evict the rest.
 *
 * @module deepseek-memory/snapshot
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { MemoryError, MemoryStore } from "./store.js";
/** Directory (inside the auxiliary tier) holding snapshots. */
export const SNAPSHOT_DIR = 'snapshots';
/** Current snapshot file format. */
export const SNAPSHOT_FORMAT = 1;
/**
 * How many snapshots of each kind are kept; oldest first out. `manual` keeps
 * everything — an explicit human request is not pruned by policy.
 */
export const SNAPSHOT_RETENTION = {
    'pre-op': 20,
    'pre-restore': 10,
    daily: 7,
    weekly: 4,
    manual: Number.POSITIVE_INFINITY,
};
/**
 * Snapshot ids are file names, so the pattern pins the exact format
 * `createSnapshot` produces — kind, ISO timestamp with `:` and `.` rendered
 * as `-`, then an 8-hex-char uuid suffix — and nothing else. The character
 * classes exclude `/`, `\`, and `.` outright: a traversal segment like
 * `daily-1/../../../../tmp/evil0000dead` can no longer satisfy the check the
 * way the previous loose `.*` allowed.
 */
const SNAPSHOT_ID_PATTERN = /^(?:pre-op|pre-restore|daily|weekly|manual)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
/**
 * The directory snapshots live in: the user tier's directory when the user
 * tier exists, otherwise the project tier's. Both capture targets stay
 * outside this directory, so a snapshot can never recursively contain itself.
 */
export function snapshotBaseDir(runtime) {
    const tiers = runtime.enabledTiers();
    const host = tiers.includes('user') ? 'user' : tiers.includes('project') ? 'project' : undefined;
    if (host === undefined) {
        throw new MemoryError('snapshots need somewhere to live, but no memory tier is enabled in this deployment.', 'MEMORY_NO_TIER');
    }
    return runtime.tierDir(host);
}
/** The snapshots directory for one deployment; creation is not implied. */
function snapshotDir(runtime) {
    return join(snapshotBaseDir(runtime), SNAPSHOT_DIR);
}
/** Read the current on-disk store file for one tier, when it exists and parses. */
function readStoreFile(file) {
    if (!existsSync(file))
        return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.entries)) {
        throw new MemoryError(`memory store at ${file} has no entries array`, 'MEMORY_STORE_MALFORMED');
    }
    return parsed;
}
/** Every enabled tier's on-disk store file, keyed by tier. */
export function readCurrentStores(runtime) {
    runtime.refresh();
    const current = {};
    for (const row of runtime.describe()) {
        if (!row.readable)
            continue;
        const file = readStoreFile(row.file);
        if (file !== undefined)
            current[row.tier] = file;
    }
    return current;
}
/**
 * Create one snapshot of the whole library as it exists on disk right now.
 *
 * The runtime cache is dropped first, so the captured state is exactly what a
 * restart would load. A deployment with nothing stored yet is refused rather
 * than snapshotted empty — restoring an empty snapshot would look like data
 * loss and be hard to distinguish from the real thing.
 */
export function createSnapshot(runtime, kind, trigger, now = Date.now()) {
    const tiers = readCurrentStores(runtime);
    if (Object.keys(tiers).length === 0) {
        throw new MemoryError('there is no memory store on disk yet, so there is nothing to snapshot.', 'MEMORY_NOTHING_TO_SNAPSHOT');
    }
    const id = `${kind}-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const payload = { snapshotVersion: SNAPSHOT_FORMAT, id, kind, trigger, createdAt: now, tiers };
    const dir = snapshotDir(runtime);
    // Snapshots hold whole tiers including personal data, so the directory is as
    // private as the store and history directories (0o700), not default umask.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${id}.json`);
    // Same write-then-rename discipline as the store itself.
    const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
        writeFileSync(temp, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8');
        renameSync(temp, file);
    }
    catch (error) {
        try {
            rmSync(temp, { force: true });
        }
        catch { /* nothing left to clean */ }
        throw error;
    }
    pruneSnapshots(runtime);
    return { id, kind, trigger, createdAt: now, file };
}
/** Every snapshot, newest first. A missing directory is an empty list, not an error. */
export function listSnapshots(runtime) {
    const dir = snapshotDir(runtime);
    if (!existsSync(dir))
        return [];
    const metas = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json'))
            continue;
        try {
            const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
            if (typeof parsed.id !== 'string' || typeof parsed.kind !== 'string' || typeof parsed.createdAt !== 'number')
                continue;
            metas.push({
                id: parsed.id,
                kind: parsed.kind,
                trigger: typeof parsed.trigger === 'string' ? parsed.trigger : 'unknown',
                createdAt: parsed.createdAt,
                file: join(dir, name),
            });
        }
        catch { /* a half-written snapshot is skipped, not fatal */ }
    }
    metas.sort((left, right) => right.createdAt - left.createdAt);
    return metas;
}
/** Load and validate one snapshot by id. */
export function loadSnapshot(runtime, id) {
    if (!SNAPSHOT_ID_PATTERN.test(id)) {
        throw new MemoryError(`"${id}" is not a snapshot id. Call memory_snapshot with action "list" to see the ids.`, 'MEMORY_SNAPSHOT_NOT_FOUND');
    }
    const dir = snapshotDir(runtime);
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) {
        throw new MemoryError(`there is no snapshot with id ${id}. Call memory_snapshot with action "list" to see the ids.`, 'MEMORY_SNAPSHOT_NOT_FOUND');
    }
    // Belt to the regex's suspenders: the id pattern excludes separators, but a
    // symlink swapped into the snapshots directory after the tier location was
    // validated could still redirect the read. Restore feeds a snapshot's
    // entries into the store, so the on-disk path is re-resolved and must sit
    // inside the real snapshots directory — the same symlink discipline the
    // store itself keeps on every commit.
    const resolvedFile = realpathSync(file);
    if (!resolvedFile.startsWith(realpathSync(dir) + sep)) {
        throw new MemoryError(`snapshot at ${file} resolves outside the snapshots directory and was not read.`, 'MEMORY_SNAPSHOT_MALFORMED');
    }
    const parsed = JSON.parse(readFileSync(resolvedFile, 'utf8'));
    if (parsed.snapshotVersion !== SNAPSHOT_FORMAT || typeof parsed.id !== 'string' || parsed.id !== id
        || typeof parsed.createdAt !== 'number' || typeof parsed.tiers !== 'object' || parsed.tiers === null) {
        throw new MemoryError(`snapshot at ${file} is malformed or uses an unsupported format.`, 'MEMORY_SNAPSHOT_MALFORMED');
    }
    // Shell validation is not entry validation. A snapshot file can arrive
    // hand-edited, corrupted, or from a shared project tier, and restore feeds
    // its entries straight into the store through the byte-preserving restore
    // path — so every tier file must pass the same per-entry normalization and
    // bounds the live store enforces on load, before any selection is applied.
    // Entries that survive come back normalized; a file the store would refuse
    // is refused here, with the store's own diagnostic.
    const tiers = parsed.tiers;
    for (const [tierName, tierFile] of Object.entries(tiers)) {
        if (tierName !== 'user' && tierName !== 'project') {
            throw new MemoryError(`snapshot at ${file} carries an unknown tier "${tierName}".`, 'MEMORY_SNAPSHOT_MALFORMED');
        }
        if (tierFile === null || typeof tierFile !== 'object' || !Array.isArray(tierFile.entries)) {
            throw new MemoryError(`snapshot at ${file} holds no entries array for its ${tierName} tier.`, 'MEMORY_SNAPSHOT_MALFORMED');
        }
        const store = new MemoryStore(tierName, runtime.storeLimits());
        store.load(tierFile, `snapshot ${id} (${tierName} tier)`);
        tiers[tierName] = { ...tierFile, entries: store.entries() };
    }
    return parsed;
}
/**
 * Enforce per-kind retention, oldest first. Failures are swallowed: pruning
 * is hygiene, and losing hygiene must never lose the snapshots themselves.
 */
export function pruneSnapshots(runtime) {
    const metas = listSnapshots(runtime);
    const byKind = new Map();
    for (const meta of metas) {
        const bucket = byKind.get(meta.kind);
        if (bucket === undefined)
            byKind.set(meta.kind, [meta]);
        else
            bucket.push(meta);
    }
    for (const [kind, bucket] of byKind) {
        const keep = SNAPSHOT_RETENTION[kind];
        if (!Number.isFinite(keep) || bucket.length <= keep)
            continue;
        for (const meta of bucket.slice(0, bucket.length - keep)) {
            try {
                rmSync(meta.file, { force: true });
            }
            catch { /* already gone */ }
        }
    }
}
/**
 * The slow-drift safety net: a daily snapshot when none exists today, a
 * weekly when none exists this ISO week.
 *
 * Runs at plugin load, so "daily" means "the first session of the day" — the
 * store changes so little that finer timing buys nothing. Failures are the
 * caller's to log; a snapshot hiccup must never stop the plugin from loading.
 */
export function maybeAutoSnapshot(runtime, now = Date.now()) {
    const created = [];
    const metas = listSnapshots(runtime);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart);
    // ISO weeks start on Monday.
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const latestDaily = metas.filter(meta => meta.kind === 'daily')[0];
    const latestWeekly = metas.filter(meta => meta.kind === 'weekly')[0];
    if (latestDaily === undefined || latestDaily.createdAt < dayStart.getTime()) {
        created.push(createSnapshot(runtime, 'daily', 'auto-load', now));
    }
    if (latestWeekly === undefined || latestWeekly.createdAt < weekStart.getTime()) {
        created.push(createSnapshot(runtime, 'weekly', 'auto-load', now));
    }
    return created;
}
