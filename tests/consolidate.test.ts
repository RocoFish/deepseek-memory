/**
 * Consolidation tests.
 *
 * The consolidator is a model, so the interesting behaviour is not what it
 * proposes but what this plugin does with a proposal: validate it, bound it, and
 * apply it all-or-nothing so a hallucinated action cannot half-rewrite a store.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ACTIONS_PER_RUN, applyActions, parseProposal, renderTranscript, validateAction } from '../src/consolidate.ts'
import { MemoryRuntime, STORE_FILE } from '../src/runtime.ts'
import type { MemoryConfig } from '../src/config.ts'
import { configFixture } from './fixtures.ts'

const config = configFixture({ maxEntries: 3, maxEntryChars: 60 })

function sandbox(overrides: Partial<MemoryConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-consolidate-'))
  const runtime = new MemoryRuntime({ ...config, ...overrides }, join(root, 'home'), join(root, 'project'), () => 1000)
  return { runtime, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

test('parseProposal reads a bare object, a fenced block, and surrounding prose', () => {
  assert.deepEqual(parseProposal('{"actions":[]}'), { actions: [] })
  assert.deepEqual(parseProposal('```json\n{"actions":[{"op":"delete","tier":"user","id":"m1"}]}\n```'), {
    actions: [{ op: 'delete', tier: 'user', id: 'm1' }],
  })
  assert.deepEqual(parseProposal('Sure!\n{"actions":[]}\nHope that helps.'), { actions: [] })
})

test('parseProposal returns undefined for junk instead of throwing', () => {
  for (const reply of ['', 'no json here', '{ broken', '[]', '{"actions":']) {
    assert.equal(parseProposal(reply), undefined, `expected undefined for ${JSON.stringify(reply)}`)
  }
})

test('validateAction accepts the three real ops', () => {
  assert.deepEqual(validateAction({ op: 'add', tier: 'project', text: 'a fact' }), {
    action: { op: 'add', tier: 'project', text: 'a fact' },
  })
  assert.deepEqual(validateAction({ op: 'update', tier: 'user', id: 'm1', text: 'new' }), {
    action: { op: 'update', tier: 'user', id: 'm1', text: 'new' },
  })
  assert.deepEqual(validateAction({ op: 'delete', tier: 'user', id: 'm1' }), {
    action: { op: 'delete', tier: 'user', id: 'm1' },
  })
})

test('validateAction refuses malformed proposals with a reason', () => {
  const cases: [unknown, RegExp][] = [
    [null, /not an object/],
    [{ op: 'add', tier: 'global', text: 'x' }, /unknown tier/],
    [{ op: 'add', tier: 'user' }, /add without text/],
    [{ op: 'add', tier: 'user', text: '   ' }, /add without text/],
    [{ op: 'update', tier: 'user', text: 'x' }, /update without id/],
    [{ op: 'update', tier: 'user', id: 'm1' }, /update without text/],
    [{ op: 'delete', tier: 'user' }, /delete without id/],
    [{ op: 'rewrite', tier: 'user', id: 'm1' }, /unknown op/],
  ]
  for (const [raw, expected] of cases) {
    const result = validateAction(raw)
    assert.ok('refusal' in result, `expected a refusal for ${JSON.stringify(raw)}`)
    assert.match((result as { refusal: string }).refusal, expected)
  }
})

test('applyActions applies a valid set and reports each change', () => {
  const box = sandbox()
  try {
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'project', text: 'the build uses tsdown' },
      { op: 'add', tier: 'user', text: 'the user prefers concise answers' },
    ], 1000)
    assert.equal(rejected.length, 0)
    assert.equal(applied.length, 2)
    assert.equal(box.runtime.store('project').size, 1)
    assert.equal(box.runtime.store('user').size, 1)
  } finally { box.cleanup() }
})

test('applyActions rolls the whole tier back when one action in it is refused', () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'a real entry worth keeping', origin: 'user', now: 1 })
    box.runtime.commit('project')
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'project', text: 'a brand new convention here' },
      { op: 'update', tier: 'project', id: 'mdoesnotexist', text: 'ghost' },
    ], 1000)
    // All-or-nothing per tier: the valid add is rolled back with the refused
    // update, so the store holds only the entry it started with.
    assert.equal(applied.length, 0)
    assert.equal(rejected.length, 2)
    assert.match(rejected[0]!, /no memory entry with id/)
    assert.match(rejected[1]!, /rolled back with the tier/)
    assert.equal(box.runtime.store('project').size, 1)
  } finally { box.cleanup() }
})

test('applyActions enforces the store ceiling by rolling the tier back', () => {
  const box = sandbox({ maxEntries: 1 })
  try {
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'project', text: 'first fact to be stored here' },
      { op: 'add', tier: 'project', text: 'second fact that will not fit' },
    ], 1000)
    assert.equal(applied.length, 0)
    assert.equal(rejected.length, 2)
    assert.match(rejected[0]!, /maximum of 1 entries/)
    assert.equal(box.runtime.store('project').size, 0)
  } finally { box.cleanup() }
})

test('applyActions keeps a clean tier committed when another tier fails', () => {
  const box = sandbox()
  try {
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'project', text: 'a project convention that applies' },
      { op: 'update', tier: 'user', id: 'mdoesnotexist', text: 'ghost' },
    ], 1000)
    // The project tier is untouched by the user tier's refusal: it commits, the
    // user tier rolls back, and neither outcome hides in an exception.
    assert.equal(applied.length, 1)
    assert.match(applied[0]!, /^add project /)
    assert.equal(rejected.length, 1)
    assert.match(rejected[0]!, /no memory entry with id/)
    assert.equal(box.runtime.store('project').size, 1)
    assert.equal(box.runtime.store('user').size, 0)
  } finally { box.cleanup() }
})

test('applyActions rejects every action of a tier whose store cannot be opened, and still applies the others', () => {
  const box = sandbox()
  try {
    // A malformed store file makes `runtime.store(tier)` itself throw. That
    // failure must reject the tier's actions with the reason — not escape the
    // per-tier loop and swallow the remaining tiers' actions silently.
    const dir = box.runtime.tierDir('project')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, STORE_FILE), 'not json at all')
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'project', text: 'doomed fact on a broken tier' },
      { op: 'add', tier: 'project', text: 'second doomed fact, same tier' },
      { op: 'add', tier: 'user', text: 'a healthy user tier fact' },
    ], 1000)
    assert.equal(applied.length, 1)
    assert.match(applied[0]!, /^add user /)
    assert.equal(rejected.length, 2)
    assert.match(rejected[0]!, /^add project: /)
    assert.match(rejected[0]!, /could not be parsed/)
    assert.match(rejected[1]!, /^add project: /)
    assert.equal(box.runtime.store('user').size, 1)
  } finally { box.cleanup() }
})

test('applyActions rejects a disabled tier', () => {
  const box = sandbox({ user: false })
  try {
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'add', tier: 'user', text: 'a personal fact that cannot be stored' },
    ], 1000)
    assert.equal(applied.length, 0)
    assert.equal(rejected.length, 1)
    assert.match(rejected[0]!, /tier user is disabled/)
  } finally { box.cleanup() }
})

test('a delete proposal removes exactly the named entry', () => {
  const box = sandbox()
  try {
    const store = box.runtime.store('project')
    const keep = store.add({ text: 'a fact that stays in memory', origin: 'user', now: 1 })
    const drop = store.add({ text: 'a fact that should be forgotten', origin: 'user', now: 1 })
    const { applied, rejected } = applyActions(box.runtime, [
      { op: 'delete', tier: 'project', id: drop.entry.id },
    ], 1000)
    assert.equal(rejected.length, 0)
    assert.equal(applied.length, 1)
    assert.equal(store.size, 1)
    assert.equal(store.entries()[0]?.id, keep.entry.id)
  } finally { box.cleanup() }
})

test('the per-run action cap is a real bound', () => {
  assert.ok(MAX_ACTIONS_PER_RUN >= 1 && MAX_ACTIONS_PER_RUN <= 32)
})

test('renderTranscript bounds the text handed to the model', () => {
  const small = renderTranscript({ userTexts: ['hello'], assistantTexts: ['hi'] })
  assert.match(small, /## User/)
  assert.match(small, /## Assistant/)
  assert.match(small, /hello/)

  const huge = renderTranscript({ userTexts: ['x'.repeat(20000)], assistantTexts: [] })
  assert.ok(huge.length < 7000, `expected a bounded transcript, got ${huge.length}`)
  assert.match(huge, /truncated/)
})
