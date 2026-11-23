/**
 * Arbitration view and adjudication tests.
 *
 * These pin the console half of the roadmap: the view reports without ever
 * touching data, every card needing attention is visible somewhere (a competing
 * group, or the flagged list), and an adjudication is a replayable registration
 * change — never a silent rewrite, never a deletion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArbitrationView, competingCards } from '../src/arbitrate.ts'
import { MemoryStore } from '../src/store.ts'
import type { MemoryEntry, MemoryScope, MemorySource, MemoryStatus, MemoryConfidence } from '../src/store.ts'

let counter = 0
/** A card with sensible defaults; overrides state what a test actually varies. */
function card(overrides: {
  scope?: MemoryScope
  subject?: string
  key?: string
  text: string
  status?: MemoryStatus
  confidence?: MemoryConfidence
  source?: MemorySource
  updatedAt?: number
  supersedes?: string[]
}): MemoryEntry {
  counter += 1
  return {
    id: `c${counter}`,
    scope: overrides.scope ?? 'project',
    subject: overrides.subject ?? 'project',
    key: overrides.key ?? 'k',
    text: overrides.text,
    status: overrides.status ?? 'active',
    confidence: overrides.confidence ?? 'high',
    source: overrides.source ?? 'user',
    supersedes: overrides.supersedes ?? [],
    tags: [],
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
    origin: 'user',
  }
}

test('a competing group shows the effective card, why it won, and what it shadowed', () => {
  const project = { tier: 'project' as const, entry: card({ scope: 'project', subject: 'deepseek-memory', key: 'test-runner', text: 'uses node:test' }) }
  const global = { tier: 'user' as const, entry: card({ scope: 'personal-global', subject: 'deepseek-memory', key: 'test-runner', text: 'prefers vitest everywhere' }) }
  const view = buildArbitrationView([global, project])
  assert.equal(view.groups.length, 1)
  const group = view.groups[0]!
  assert.equal(group.decidedBy, 'scope')
  assert.deepEqual(group.cards.map(c => c.layer), ['effective', 'shadowed'])
  assert.equal(group.cards[0]!.entry.id, project.entry.id)
  assert.equal(group.cards[1]!.entry.id, global.entry.id)
})

test('an imported card that shares a live group shows as pending; an unclaimed one is flagged', () => {
  const live = { tier: 'user' as const, entry: card({ scope: 'personal-global', subject: 'preference', key: 'editor', text: 'uses VS Code' }) }
  const claimed = { tier: 'user' as const, entry: card({ scope: 'imported', subject: 'preference', key: 'editor', text: 'used Vim once' }) }
  const unclaimed = { tier: 'user' as const, entry: card({ scope: 'imported', subject: 'old-tool', key: 'k', text: 'from an ancient backup' }) }
  const view = buildArbitrationView([live, claimed, unclaimed])
  const group = view.groups.find(g => g.subject === 'preference')!
  assert.equal(group.cards.filter(c => c.layer === 'pending').length, 1, 'the claimed import sits in the group as pending')
  assert.equal(group.cards.filter(c => c.layer === 'pending')[0]!.entry.id, claimed.entry.id)
  assert.ok(view.flagged.some(f => f.entry.id === unclaimed.entry.id && f.reason === 'imported'), 'the unclaimed import is flagged')
  assert.equal(view.stats.imported, 2)
})

test('a personal card sitting in the project tier is flagged as a scope violation', () => {
  const misplaced = { tier: 'project' as const, entry: card({ scope: 'personal-global', subject: 'preference', key: 'k', text: 'escaped from the user tier' }) }
  const view = buildArbitrationView([misplaced])
  assert.ok(view.flagged.some(f => f.entry.id === misplaced.entry.id && f.reason === 'scope-violation'))
  assert.equal(view.stats.violations, 1)
})

test('a weakly supported in-force card that competes in no group is flagged low-confidence', () => {
  const weak = { tier: 'user' as const, entry: card({ scope: 'personal-topic', subject: 'math-modeling', key: 'team-size', text: 'maybe a team of four', confidence: 'low' }) }
  const view = buildArbitrationView([weak])
  assert.ok(view.flagged.some(f => f.entry.id === weak.entry.id && f.reason === 'low-confidence'))
})

test('adopting a value lists its live competitors, across tiers', () => {
  const winner = card({ scope: 'project', subject: 'deepseek-memory', key: 'test-runner', text: 'uses node:test' })
  const sameGroupGlobal = card({ scope: 'personal-global', subject: 'deepseek-memory', key: 'test-runner', text: 'prefers vitest' })
  const otherKey = card({ scope: 'personal-global', subject: 'deepseek-memory', key: 'linter', text: 'uses eslint' })
  const supersededOld = card({ scope: 'project', subject: 'deepseek-memory', key: 'test-runner', text: 'used jest before', status: 'superseded' })
  const competitors = competingCards(winner, [
    { tier: 'user', entry: sameGroupGlobal },
    { tier: 'user', entry: otherKey },
    { tier: 'project', entry: supersededOld },
    { tier: 'project', entry: winner },
  ])
  assert.deepEqual(competitors.map(({ entry }) => entry.id), [sameGroupGlobal.id], 'only live same-group cards compete; other keys and already-superseded cards do not')
})

test('adjudicate changes registration fields only and bumps the revision, keeping text and id', () => {
  const store = new MemoryStore('user', { maxEntries: 5, maxEntryChars: 200 })
  const { entry } = store.add({ text: 'the assistant is called 小鱼', origin: 'user', now: 1 })
  const before = store.revision
  const adjudicated = store.adjudicate({
    id: entry.id,
    status: 'superseded',
    confidence: 'low',
    supersedes: ['c-old'],
    origin: 'user',
    now: 2,
  })
  assert.equal(adjudicated.id, entry.id)
  assert.equal(adjudicated.text, entry.text, 'arbitration must never rewrite the fact itself')
  assert.equal(adjudicated.status, 'superseded')
  assert.equal(adjudicated.confidence, 'low')
  assert.deepEqual(adjudicated.supersedes, ['c-old'])
  assert.equal(store.revision, before + 1, 'every arbitration is one replayable step')
})

test('adjudicate refuses a scope the tier cannot hold', () => {
  const store = new MemoryStore('user', { maxEntries: 5, maxEntryChars: 200 })
  const { entry } = store.add({ text: 'a personal fact', origin: 'user', now: 1 })
  assert.throws(
    () => store.adjudicate({ id: entry.id, scope: 'project', origin: 'user', now: 2 }),
    /does not belong in the user memory tier/,
  )
})

test('upsertRestored replaces by id or inserts, bypassing write validation for recovery', () => {
  const store = new MemoryStore('user', { maxEntries: 1, maxEntryChars: 200 })
  const imported: MemoryEntry = {
    ...card({ scope: 'imported', subject: 'old-tool', key: 'k', text: 'recovered from a snapshot' }),
    updatedAt: 5,
  }
  store.upsertRestored(imported)
  assert.equal(store.size, 1)
  // The live-card cap would reject a normal add at this point; restore must not.
  store.upsertRestored({ ...imported, text: 'recovered and rewritten', updatedAt: 6 })
  assert.equal(store.size, 1)
  assert.equal(store.entries()[0]!.text, 'recovered and rewritten')
})
