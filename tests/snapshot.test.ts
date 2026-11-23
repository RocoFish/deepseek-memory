/**
 * Snapshot, export, and restore tests — the "take it with you, and look before
 * you roll back" half of the roadmap.
 *
 * The acceptance cases pinned here, straight from the plan:
 *
 * - an exported bundle verifies, and deleting one card file is a *located*
 *   failure, not a silent gap;
 * - credential-shaped strings are masked and counted, never exported raw;
 * - restore always previews first, backs up the current library before
 *   writing, and touches only the confirmed selections.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArbitrationView } from '../src/arbitrate.ts'
import { assembleBundle, buildZip, redactSecrets, verifyExport, writeBundle } from '../src/export.ts'
import { applyRestore, diffRestore } from '../src/restore.ts'
import { MemoryRuntime, PROJECT_MEMORY_DIR, STORE_FILE, USER_MEMORY_DIR } from '../src/runtime.ts'
import { createSnapshot, listSnapshots, loadSnapshot, maybeAutoSnapshot, SNAPSHOT_DIR } from '../src/snapshot.ts'
import type { MemoryConfig } from '../src/config.ts'
import { createMemoryTools } from '../src/tools.ts'
import { configFixture } from './fixtures.ts'

const config = configFixture()

function sandbox(overrides: Partial<MemoryConfig> = {}): { root: string; home: string; cwd: string; runtime: MemoryRuntime; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'memory-snap-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  const runtime = new MemoryRuntime({ ...config, ...overrides }, home, cwd, () => 1000)
  return { root, home, cwd, runtime, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

function tool(runtime: MemoryRuntime, name: string) {
  const definition = createMemoryTools(runtime).find(candidate => candidate.name === name)
  assert.ok(definition, `tool ${name} must exist`)
  return definition
}

/* ------------------------------------------------------------ snapshots */

test('a snapshot captures both tiers as they live on disk', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'the build uses tsc', origin: 'user', now: 1 })
    box.runtime.commit('project')
    box.runtime.store('user').add({ text: 'the assistant is called 小鱼', origin: 'user', now: 1 })
    box.runtime.commit('user')

    const meta = createSnapshot(box.runtime, 'manual', 'test', 5000)
    assert.ok(meta.id.startsWith('manual-'))
    assert.ok(existsSync(meta.file), 'the snapshot file must exist')
    assert.equal(meta.file, join(box.home, USER_MEMORY_DIR, SNAPSHOT_DIR, `${meta.id}.json`), 'snapshots live in the user tier, not the project repo')

    const loaded = loadSnapshot(box.runtime, meta.id)
    assert.equal(loaded.tiers.project?.entries.length, 1)
    assert.equal(loaded.tiers.user?.entries.length, 1)
    assert.equal(loaded.tiers.user?.entries[0]!.text, 'the assistant is called 小鱼')
  } finally { box.cleanup() }
})

test('snapshotting an empty library is refused, not recorded as an empty truth', () => {
  const box = sandbox()
  try {
    assert.throws(() => createSnapshot(box.runtime, 'manual', 'test'), /nothing to snapshot/)
  } finally { box.cleanup() }
})

test('snapshot ids are validated, never concatenated into paths', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a fact', origin: 'user', now: 1 })
    box.runtime.commit('project')
    assert.throws(() => loadSnapshot(box.runtime, '../../etc/passwd'), /not a snapshot id/)
    assert.throws(() => loadSnapshot(box.runtime, 'manual-2099-01-01T00-00-00-000Z-deadbeef'), /no snapshot with id/)
  } finally { box.cleanup() }
})

test('pre-op snapshots are pruned to the newest twenty', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a fact', origin: 'user', now: 1 })
    box.runtime.commit('project')
    for (let index = 0; index < 25; index += 1) {
      createSnapshot(box.runtime, 'pre-op', `op-${index}`, 10_000 + index * 1000)
    }
    const preOps = listSnapshots(box.runtime).filter(meta => meta.kind === 'pre-op')
    assert.equal(preOps.length, 20)
  } finally { box.cleanup() }
})

test('auto snapshots: one daily and one weekly today, nothing the same day, a new daily tomorrow', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a fact', origin: 'user', now: 1 })
    box.runtime.commit('project')
    // 2026-11-23 is a Monday, so noon UTC sits inside the same local day/week
    // for any timezone within ±12h.
    const monday = Date.parse('2026-11-23T12:00:00Z')
    const first = maybeAutoSnapshot(box.runtime, monday)
    assert.deepEqual(first.map(meta => meta.kind).sort(), ['daily', 'weekly'])

    const second = maybeAutoSnapshot(box.runtime, monday + 60_000)
    assert.equal(second.length, 0, 'a second load the same day snapshots nothing')

    const tuesday = Date.parse('2026-11-24T12:00:00Z')
    const third = maybeAutoSnapshot(box.runtime, tuesday)
    assert.deepEqual(third.map(meta => meta.kind), ['daily'], 'a new day brings one daily; the week is still covered')
    assert.equal(listSnapshots(box.runtime).filter(meta => meta.kind === 'weekly').length, 1)
  } finally { box.cleanup() }
})

/* ---------------------------------------------------------------- export */

test('a markdown bundle verifies, and a deleted card file is a located failure', () => {
  const box = sandbox()
  try {
    const dest = mkdtempSync(join(tmpdir(), 'memory-export-'))
    const cardA = box.runtime.store('project').add({ text: 'the build uses tsc', origin: 'user', now: 1 })
    const cardB = box.runtime.store('project').add({ text: 'tests use node:test', origin: 'user', now: 2 })
    const tiered = [
      { tier: 'project' as const, entry: cardA.entry },
      { tier: 'project' as const, entry: cardB.entry },
    ]
    const bundle = assembleBundle({
      createdAt: 3000,
      selection: { entries: tiered.map(({ entry }) => entry), exclusions: [], includesPersonalGlobal: false },
      view: buildArbitrationView(tiered),
      scopes: ['project'],
    })
    writeBundle(dest, bundle, false)
    assert.ok(existsSync(join(dest, 'INDEX.md')))
    assert.ok(existsSync(join(dest, 'cards', `${cardA.entry.id}.md`)))

    const verified = verifyExport(dest)
    assert.ok(verified.ok, `bundle must verify: ${JSON.stringify(verified)}`)

    rmSync(join(dest, 'cards', `${cardA.entry.id}.md`))
    const broken = verifyExport(dest)
    assert.equal(broken.ok, false)
    assert.deepEqual(broken.missing, [`cards/${cardA.entry.id}.md`], 'the manifest locates exactly the missing card')

    // A tampered card fails its hash even though the file exists.
    writeFileSync(join(dest, 'cards', `${cardB.entry.id}.md`), 'tampered\n')
    const tampered = verifyExport(dest)
    assert.deepEqual(tampered.mismatched, [`cards/${cardB.entry.id}.md`])
    rmSync(dest, { recursive: true, force: true })
  } finally { box.cleanup() }
})

test('credential-shaped strings are masked in exports and counted in the manifest', () => {
  const box = sandbox()
  try {
    const leaked = box.runtime.store('user').add({
      text: 'the deploy key is ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 in prod',
      origin: 'user',
      now: 1,
    })
    assert.equal(leaked.created, true)
    const redacted = redactSecrets(leaked.entry.text)
    assert.ok(!redacted.text.includes('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), 'the raw token must not survive into the export')
    assert.ok(redacted.text.includes('[REDACTED:github-token]'))
    assert.deepEqual(redacted.report, [{ label: 'github-token', count: 1 }])

    const bundle = assembleBundle({
      createdAt: 3000,
      selection: { entries: [leaked.entry], exclusions: [], includesPersonalGlobal: true },
      view: buildArbitrationView([{ tier: 'user', entry: leaked.entry }]),
      scopes: ['personal-global'],
    })
    const manifest = JSON.parse(bundle.files.find(file => file.path === 'MANIFEST.json')!.data.toString('utf8'))
    assert.deepEqual(manifest.redaction, [{ label: 'github-token', count: 1 }])
    const cardFile = bundle.files.find(file => file.path === `cards/${leaked.entry.id}.md`)!
    assert.ok(!cardFile.data.toString('utf8').includes('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'))
    // INDEX.md prints the view's unredacted texts — the leak there is the
    // same leak, so it must be masked too.
    const indexFile = bundle.files.find(file => file.path === 'INDEX.md')!
    assert.ok(!indexFile.data.toString('utf8').includes('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'), 'INDEX.md must not smuggle a secret the cards masked')
    assert.ok(indexFile.data.toString('utf8').includes('[REDACTED:github-token]'))
  } finally { box.cleanup() }
})

test('the hand-rolled zip carries every bundle file with correct sizes', () => {
  const files = [
    { path: 'INDEX.md', data: Buffer.from('# hello\n') },
    { path: 'cards/m1234abcd.md', data: Buffer.from('---\n---\nbody\n') },
  ]
  const zip = buildZip(files, Date.parse('2026-11-23T12:00:00Z'))
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature')
  // EOCD trailer (22 bytes): signature 0, counts at 8/10, dir size 12, dir
  // offset 16, comment length 20.
  const total = zip.readUInt16LE(zip.length - 12)
  assert.equal(total, 2, 'end-of-central-directory counts both entries')
  const centralSize = zip.readUInt32LE(zip.length - 10)
  const centralOffset = zip.readUInt32LE(zip.length - 6)
  assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50, 'central directory signature')
  assert.equal(centralOffset + centralSize + 22, zip.length, 'the trailer follows the central directory exactly')
})

/* --------------------------------------------------------------- restore */

test('a restore preview sorts changes into added, removed, modified, and conflicts', () => {
  const box = sandbox()
  try {
    const store = box.runtime.store('project')
    const modifiedOld = store.add({ text: 'fact one, original wording', origin: 'user', now: 1 })
    const conflicted = store.add({ text: 'fact two, snapshot wording', origin: 'user', now: 1 })
    const readded = store.add({ text: 'fact three, deleted after the snapshot', origin: 'user', now: 1 })
    box.runtime.commit('project')
    const snapshot = loadSnapshot(box.runtime, createSnapshot(box.runtime, 'manual', 'test', 2000).id)
    // Snapshot creation refreshed the runtime cache, so mutations from here
    // must go through a freshly loaded store to survive the next commit.
    const after = box.runtime.store('project')

    // Modified: changed before the snapshot's time horizon (older updatedAt).
    after.update({ id: modifiedOld.entry.id, text: 'fact one, reworded quietly', origin: 'user', now: 1500 })
    // Conflict: changed after the snapshot was taken — work the snapshot never saw.
    after.update({ id: conflicted.entry.id, text: 'fact two, rewritten after the snapshot', origin: 'user', now: 5000 })
    // Added: in the snapshot, removed afterwards.
    after.remove(readded.entry.id, 6000)
    // Removed: born after the snapshot.
    after.add({ text: 'fact four, born after the snapshot', origin: 'user', now: 7000 })
    box.runtime.commit('project')

    const plan = diffRestore(snapshot, (() => { box.runtime.refresh(); return readCurrent(box) })())
    const tier = plan.tiers.find(entry => entry.tier === 'project')!
    assert.deepEqual(tier.modified.map(entry => entry.id), [modifiedOld.entry.id])
    assert.deepEqual(tier.conflicts.map(entry => entry.id), [conflicted.entry.id])
    assert.equal(tier.conflicts[0]!.current.text, 'fact two, rewritten after the snapshot')
    assert.equal(tier.conflicts[0]!.snapshot.text, 'fact two, snapshot wording')
    assert.deepEqual(tier.added.map(entry => entry.id), [readded.entry.id])
    assert.deepEqual(tier.removed.map(entry => entry.text), ['fact four, born after the snapshot'])
  } finally { box.cleanup() }
})

function readCurrent(box: { runtime: MemoryRuntime }): Parameters<typeof diffRestore>[1] {
  const current: Parameters<typeof diffRestore>[1] = {}
  for (const tier of ['project', 'user'] as const) {
    try {
      const file = join(tier === 'project' ? box.runtime.tierDir('project') : box.runtime.tierDir('user'), STORE_FILE)
      if (existsSync(file)) current[tier] = JSON.parse(readFileSync(file, 'utf8'))
    } catch { /* tier unreadable or absent: out of scope for the diff */ }
  }
  return current
}

test('restore applies only confirmed selections and backs the library up first', () => {
  const box = sandbox()
  try {
    const store = box.runtime.store('project')
    const quiet = store.add({ text: 'fact one, original wording', origin: 'user', now: 1 })
    const removed = store.add({ text: 'fact three, deleted after the snapshot', origin: 'user', now: 1 })
    const survivor = store.add({ text: 'fact five, never in the snapshot', origin: 'user', now: 1 })
    box.runtime.commit('project')
    const snapshot = loadSnapshot(box.runtime, createSnapshot(box.runtime, 'manual', 'test', 2000).id)
    // The snapshot refreshed the cache; take a fresh store for post-snapshot edits.
    const after = box.runtime.store('project')
    after.update({ id: quiet.entry.id, text: 'fact one, reworded quietly', origin: 'user', now: 1500 })
    after.remove(removed.entry.id, 6000)
    box.runtime.commit('project')

    const beforeApply = listSnapshots(box.runtime).length
    const result = applyRestore(box.runtime, snapshot, [
      { tier: 'project', id: quiet.entry.id, direction: 'modify' },
      { tier: 'project', id: removed.entry.id, direction: 'add' },
    ], 8000)
    assert.ok(result.preRestoreId.startsWith('pre-restore-'), 'the current library is backed up before anything is written')
    assert.equal(listSnapshots(box.runtime).length, beforeApply + 1)

    const reopened = new MemoryRuntime(config, box.home, box.cwd, () => 9000)
    const entries = reopened.store('project').entries()
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    assert.equal(byId.get(quiet.entry.id)!.text, 'fact one, original wording', 'the confirmed modification is rolled back')
    assert.ok(byId.has(removed.entry.id), 'the confirmed deletion is re-added')
    assert.ok(byId.has(survivor.entry.id), 'unselected entries are untouched')
  } finally { box.cleanup() }
})

/* ----------------------------------------------------------- tool wiring */

test('memory_arbitrate adopt takes a pre-op snapshot, demotes competitors, and commits', async () => {
  const box = sandbox()
  try {
    const project = box.runtime.store('project').add({ text: 'this repo tests with node:test', origin: 'user', now: 1, subject: 'deepseek-memory', key: 'test-runner' })
    box.runtime.commit('project')
    const global = box.runtime.store('user').add({ text: 'deepseek-memory tests with vitest', origin: 'user', now: 1, subject: 'deepseek-memory', key: 'test-runner' })
    box.runtime.commit('user')

    const result = await tool(box.runtime, 'memory_arbitrate').execute({
      action: 'adopt',
      ids: [project.entry.id],
    }, undefined)
    assert.match(String(result), /Adopted/)
    assert.match(String(result), /Pre-operation snapshot: manual|pre-op/)

    const after = new MemoryRuntime(config, box.home, box.cwd, () => 2000)
    const winner = after.store('project').entries().find(entry => entry.id === project.entry.id)!
    assert.equal(winner.confidence, 'user-confirmed')
    assert.deepEqual(winner.supersedes, [global.entry.id], 'the winner records what it demoted, so the decision replays')
    const loser = after.store('user').entries().find(entry => entry.id === global.entry.id)!
    assert.equal(loser.status, 'superseded', 'the loser is demoted, never deleted')
    assert.ok(listSnapshots(after).some(meta => meta.kind === 'pre-op'))
  } finally { box.cleanup() }
})

test('memory_conflicts renders the console and changes nothing', async () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'uses node:test', origin: 'user', now: 1, subject: 'deepseek-memory', key: 'test-runner' })
    box.runtime.commit('project')
    const before = readFileSync(join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE), 'utf8')
    const output = String(await tool(box.runtime, 'memory_conflicts').execute({}, undefined))
    assert.match(output, /deepseek-memory \/ test-runner/)
    assert.equal(readFileSync(join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE), 'utf8'), before, 'the console is read-only')
  } finally { box.cleanup() }
})

test('memory_restore refuses to apply without confirmed selections', async () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a fact', origin: 'user', now: 1 })
    box.runtime.commit('project')
    const snapshot = createSnapshot(box.runtime, 'manual', 'test')
    await assert.rejects(
      tool(box.runtime, 'memory_restore').execute({ snapshot: snapshot.id, action: 'apply', apply: [] }, undefined),
      /at least one confirmed selection/,
    )
  } finally { box.cleanup() }
})

test('memory_export writes a verifiable markdown package through the tool', async () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'the build uses tsc', origin: 'user', now: 1 })
    box.runtime.commit('project')
    box.runtime.store('user').add({ text: 'the assistant is called 小鱼', origin: 'user', now: 1 })
    box.runtime.commit('user')
    const dest = mkdtempSync(join(tmpdir(), 'memory-tool-export-'))
    const output = String(await tool(box.runtime, 'memory_export').execute({ format: 'markdown', dest }, undefined))
    assert.match(output, /Exported 2 cards/)
    const verified = verifyExport(dest)
    assert.ok(verified.ok, `tool export must verify: ${JSON.stringify(verified)}`)
    const index = readFileSync(join(dest, 'INDEX.md'), 'utf8')
    assert.match(index, /entries: 2/)
    assert.match(index, /includes_personal_global: true/)
    rmSync(dest, { recursive: true, force: true })
  } finally { box.cleanup() }
})
