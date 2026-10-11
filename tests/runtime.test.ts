/**
 * Durability tests for the two-tier runtime.
 *
 * Memory that can be corrupted is worse than no memory, so the properties under
 * test here are the ones that make the store trustworthy: the file survives a
 * round trip, a rewrite keeps the old revision recoverable, and the two tiers
 * never bleed into each other.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRuntime, PROJECT_MEMORY_DIR, STORE_FILE, USER_MEMORY_DIR } from '../src/runtime.ts'
import { createMemoryTools } from '../src/tools.ts'
import { STORE_FORMAT } from '../src/store.ts'
import type { MemoryConfig } from '../src/config.ts'
import { configFixture } from './fixtures.ts'

const config = configFixture()

function sandbox(overrides: Partial<MemoryConfig> = {}): { root: string; home: string; cwd: string; runtime: MemoryRuntime; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'memory-test-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  // The tier directories are created by the runtime on the first commit, so a
  // test can assert that merely reading never creates them.
  const runtime = new MemoryRuntime({ ...config, ...overrides }, home, cwd, () => 1000)
  return {
    root,
    home,
    cwd,
    runtime,
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

test('a fresh runtime starts empty with both tiers enabled, project first', () => {
  const box = sandbox()
  try {
    assert.deepEqual(box.runtime.enabledTiers(), ['project', 'user'])
    assert.equal(box.runtime.store('project').size, 0)
    assert.equal(box.runtime.store('user').size, 0)
    assert.equal(existsSync(join(box.cwd, PROJECT_MEMORY_DIR)), false, 'reading must not create directories')
  } finally { box.cleanup() }
})

test('a commit writes the store and a second runtime reads it back', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'the build uses tsdown', origin: 'user', now: 1 })
    box.runtime.commit('project')

    const file = join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE)
    assert.ok(existsSync(file), 'the store file must exist after a commit')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.format, STORE_FORMAT)
    assert.equal(parsed.tier, 'project')
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].text, 'the build uses tsdown')

    const reopened = new MemoryRuntime(config, box.home, box.cwd, () => 2000)
    assert.equal(reopened.store('project').size, 1, 'a new runtime must observe the committed entry')
  } finally { box.cleanup() }
})

test('a commit keeps the previous revision recoverable', () => {
  const box = sandbox()
  try {
    const file = join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE)
    box.runtime.store('project').add({ text: 'first revision of the fact', origin: 'user', now: 1 })
    box.runtime.commit('project')
    box.runtime.store('project').add({ text: 'second revision of the fact', origin: 'user', now: 2 })
    box.runtime.commit('project')

    const historyDir = join(box.cwd, PROJECT_MEMORY_DIR, 'history')
    const backups = readdirSync(historyDir)
    assert.ok(backups.length >= 1, 'the previous revision must be kept')
    const previous = JSON.parse(readFileSync(join(historyDir, backups[0]!), 'utf8'))
    assert.equal(previous.entries.length, 1)
    assert.equal(previous.entries[0].text, 'first revision of the fact')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.length, 2)
  } finally { box.cleanup() }
})

test('history can be turned off without breaking the commit', () => {
  const box = sandbox({ keepHistory: false })
  try {
    box.runtime.store('project').add({ text: 'a fact with no history kept', origin: 'user', now: 1 })
    box.runtime.commit('project')
    box.runtime.store('project').add({ text: 'another fact with no history', origin: 'user', now: 2 })
    box.runtime.commit('project')
    assert.equal(existsSync(join(box.cwd, PROJECT_MEMORY_DIR, 'history')), false)
    assert.equal(JSON.parse(readFileSync(join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE), 'utf8')).entries.length, 2)
  } finally { box.cleanup() }
})

test('the two tiers write to different files and never share entries', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a project convention worth keeping', origin: 'user', now: 1 })
    box.runtime.store('user').add({ text: 'a personal preference worth keeping', origin: 'user', now: 1 })
    box.runtime.commit('project')
    box.runtime.commit('user')

    assert.ok(existsSync(join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE)))
    assert.ok(existsSync(join(box.home, USER_MEMORY_DIR, STORE_FILE)))

    const projectFile = JSON.parse(readFileSync(join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE), 'utf8'))
    const userFile = JSON.parse(readFileSync(join(box.home, USER_MEMORY_DIR, STORE_FILE), 'utf8'))
    assert.equal(projectFile.tier, 'project')
    assert.equal(userFile.tier, 'user')
    assert.equal(projectFile.entries[0].text, 'a project convention worth keeping')
    assert.equal(userFile.entries[0].text, 'a personal preference worth keeping')
  } finally { box.cleanup() }
})

test('a tier can be disabled by configuration', () => {
  const box = sandbox({ user: false })
  try {
    assert.deepEqual(box.runtime.enabledTiers(), ['project'])
    const both = sandbox({ user: false, project: false })
    try {
      assert.deepEqual(both.runtime.enabledTiers(), [])
      assert.deepEqual(both.runtime.stores(), [])
      assert.deepEqual(both.runtime.describe(), [])
    } finally { both.cleanup() }
  } finally { box.cleanup() }
})

test('refresh re-reads an externally edited file', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a fact from the plugin', origin: 'user', now: 1 })
    box.runtime.commit('project')
    const file = join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE)

    // A user hand-edits the file, which is the whole point of keeping it plain.
    const edited = JSON.parse(readFileSync(file, 'utf8'))
    edited.entries.push({ id: 'manual', text: 'a fact added by hand', tags: [], createdAt: 5, updatedAt: 5, origin: 'user' })
    writeFileSync(file, JSON.stringify(edited))

    assert.equal(box.runtime.store('project').size, 1, 'the cached read must not see it yet')
    box.runtime.refresh()
    assert.equal(box.runtime.store('project').size, 2, 'refresh must observe the edit')
  } finally { box.cleanup() }
})

test('an unparseable store reports a typed error instead of crashing', () => {
  const box = sandbox()
  try {
    const dir = join(box.cwd, PROJECT_MEMORY_DIR)
    box.runtime.store('project').add({ text: 'seed the directory', origin: 'user', now: 1 })
    box.runtime.commit('project')
    writeFileSync(join(dir, STORE_FILE), '{ not json')
    box.runtime.refresh()

    assert.throws(
      () => box.runtime.store('project'),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'MEMORY_STORE_UNREADABLE',
    )
    // And the failure is contained: describe() reports it without throwing.
    const described = box.runtime.describe()
    assert.equal(described.find(row => row.tier === 'project')?.readable, false)
  } finally { box.cleanup() }
})

test('a project directory that changes under the runtime is re-resolved, not cached', () => {
  // The project directory arrives from the session's own record, which is not
  // known when the plugin is applied — and a host can move to another project
  // without restarting the plugin. If the runtime kept the first location, project
  // memory would be read from and written to the wrong tree: invisible where it is
  // wanted, misleading where it is found.
  const root = mkdtempSync(join(tmpdir(), 'memory-test-'))
  const home = join(root, 'home')
  const first = join(root, 'project-one')
  const second = join(root, 'project-two')
  let current: string = first
  // A fresh config instance, not the module-level shared one: this test drives the
  // runtime through a mutable directory, and it must not be able to observe (or
  // leave) state from a sibling test.
  const runtime = new MemoryRuntime(configFixture(), home, () => current, () => 1000)
  const projectRow = () => runtime.describe().find(row => row.tier === 'project')
  try {
    assert.equal(
      projectRow()?.file,
      join(first, PROJECT_MEMORY_DIR, STORE_FILE),
      'the project tier starts under the first project',
    )

    runtime.store('project').add({ text: 'belongs to project one', origin: 'user', now: 1 })
    runtime.commit('project')

    // The host moves to another project.
    current = second
    assert.equal(
      projectRow()?.file,
      join(second, PROJECT_MEMORY_DIR, STORE_FILE),
      'the location must follow the project',
    )
    assert.equal(projectRow()?.entries, 0, "the other project must not inherit this one's memory")

    // Going back sees the first project's memory again, from its own file.
    current = first
    assert.equal(
      projectRow()?.entries,
      1,
      "the first project's memory must be reloaded from disk, not left behind in a stale cache",
    )
    assert.equal(projectRow()?.revision, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('memory_status re-reads from disk, so it can explain a store that changed underneath it', async () => {
  // This tool exists to answer "why does memory look wrong", and every interesting
  // answer to that — a hand-edited file, a corrupted one, a fact the user deleted
  // themselves — lives on disk. The runtime caches stores for prompt assembly, so
  // without an explicit refresh the tool could only ever report the state as of the
  // last write, i.e. the one state that is never in doubt. This test is the guard
  // on that refresh.
  const box = sandbox()
  try {
    const tool = createMemoryTools(box.runtime).find(candidate => candidate.name === 'memory_status')
    assert.ok(tool !== undefined, 'memory_status must be registered')

    // Seed through the plugin so the file and the cache agree.
    box.runtime.store('project').add({ text: 'a fact from the plugin', origin: 'user', now: 1 })
    box.runtime.commit('project')
    assert.match(String(await tool.execute({}, {})), /project: 1 entries/)

    // Now the file changes without the plugin's knowledge.
    const file = join(box.cwd, PROJECT_MEMORY_DIR, STORE_FILE)
    const edited = JSON.parse(readFileSync(file, 'utf8'))
    edited.entries.push({ id: 'manual', text: 'a fact added by hand', tags: [], createdAt: 5, updatedAt: 5, origin: 'user' })
    writeFileSync(file, JSON.stringify(edited))

    assert.equal(box.runtime.store('project').size, 1, 'the cache must still be stale at this point')
    assert.match(
      String(await tool.execute({}, {})),
      /project: 2 entries/,
      'memory_status must observe the hand edit rather than report its cached view',
    )

    // And a file it cannot parse is reported, not thrown.
    writeFileSync(file, '{ not json')
    assert.match(String(await tool.execute({}, {})), /UNREADABLE/)
  } finally { box.cleanup() }
})
