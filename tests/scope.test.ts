/**
 * Scope resolution tests.
 *
 * These pin the two behavioural contracts behind the household-registration
 * model:
 *
 * 1. Which value of a (subject, key) group is in force, and *why* — scope
 *    rank, then confidence, then recency, each observable in the result.
 * 2. Nothing is silently discarded: shadowed cards and excluded cards are
 *    returned with their reasons, which is what makes arbitration replayable.
 *
 * The user-facing acceptance cases map onto named tests below: a project rule
 * must beat a global preference inside a project session; an imported card
 * must never affect an answer; a personal-topic card is invisible until its
 * subject is in play.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectScopeViolation, findScopeViolations, resolveEffective } from '../src/scope.ts'
import type { MemoryEntry, MemorySource, MemoryStatus, MemoryConfidence, MemoryScope } from '../src/store.ts'

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

test('project scope beats personal-global inside a project session', () => {
  // Grouping is (subject, key): the two cards must claim the same subject for
  // the scope precedence to be the thing under test.
  const projectCard = card({ scope: 'project', subject: 'deepseek-memory', key: 'test-runner', text: 'this repo uses node:test' })
  const globalCard = card({ scope: 'personal-global', subject: 'deepseek-memory', key: 'test-runner', text: 'prefers vitest everywhere' })
  const result = resolveEffective([globalCard, projectCard])
  assert.equal(result.groups.length, 1)
  const group = result.groups[0]!
  assert.equal(group.effective.id, projectCard.id)
  assert.equal(group.decidedBy, 'scope')
  assert.deepEqual(group.shadowed.map(entry => entry.id), [globalCard.id],
    'the losing card is kept for the arbitration view, not deleted')
})

test('the winner listed first still reports the axis that decided the group', () => {
  // The winner must not depend on candidate order: with the project card
  // first, the group is still decided by scope, not by the default recency.
  const projectCard = card({ scope: 'project', subject: 'deepseek-memory', key: 'test-runner', text: 'this repo uses node:test' })
  const globalCard = card({ scope: 'personal-global', subject: 'deepseek-memory', key: 'test-runner', text: 'prefers vitest everywhere' })
  const { groups } = resolveEffective([projectCard, globalCard])
  assert.equal(groups[0]!.effective.id, projectCard.id)
  assert.equal(groups[0]!.decidedBy, 'scope')
})

test('a user-confirmed card beats a newer assistant inference in the same scope', () => {
  const confirmed = card({ scope: 'personal-global', key: 'search-engine', text: 'search with Bing first', confidence: 'user-confirmed', updatedAt: 1 })
  const inferred = card({ scope: 'personal-global', key: 'search-engine', text: 'maybe prefers Google now', confidence: 'medium', source: 'assistant', updatedAt: 99 })
  const { groups } = resolveEffective([inferred, confirmed])
  assert.equal(groups[0]!.effective.id, confirmed.id)
  assert.equal(groups[0]!.decidedBy, 'confidence',
    'confirmation outranks recency inside one scope')
})

test('inside one scope and one confidence, the newer card wins', () => {
  const older = card({ scope: 'personal-global', key: 'assistant-name', text: 'the assistant is called 小鱼', updatedAt: 10 })
  const newer = card({ scope: 'personal-global', key: 'assistant-name', text: 'the assistant is called 奇米', confidence: 'user-confirmed', updatedAt: 20 })
  const { groups } = resolveEffective([older, newer])
  assert.equal(groups[0]!.effective.id, newer.id)
  assert.equal(groups[0]!.decidedBy, 'confidence')
})

test('recency breaks the tie only when scope and confidence match', () => {
  const older = card({ scope: 'personal-global', key: 'editor', text: 'uses VS Code', updatedAt: 10 })
  const newer = card({ scope: 'personal-global', key: 'editor', text: 'uses neovim', updatedAt: 20 })
  const { groups } = resolveEffective([older, newer])
  assert.equal(groups[0]!.effective.id, newer.id)
  assert.equal(groups[0]!.decidedBy, 'recency')
})

test('imported cards never affect answers', () => {
  const imported = card({ scope: 'imported', key: 'editor', text: 'imported claim: uses emacs' })
  const own = card({ scope: 'personal-global', key: 'editor', text: 'uses VS Code', updatedAt: 5 })
  const result = resolveEffective([imported, own])
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0]!.effective.id, own.id)
  const excluded = result.excluded.find(item => item.entry.id === imported.id)
  assert.equal(excluded?.reason, 'imported')
})

test('superseded and archived cards are excluded by status but reported', () => {
  const old = card({ scope: 'personal-global', key: 'plan', text: 'will upgrade later', status: 'superseded' })
  const current = card({ scope: 'personal-global', key: 'plan', text: 'upgraded already', updatedAt: 9 })
  const result = resolveEffective([old, current])
  assert.equal(result.groups[0]!.effective.id, current.id)
  assert.equal(result.excluded.find(item => item.entry.id === old.id)?.reason, 'status')
})

test('personal-topic cards are invisible until their subject is in play', () => {
  const modeling = card({ scope: 'personal-topic', subject: 'math-modeling', key: 'stack', text: 'models in Python, not MATLAB' })
  const withoutSubject = resolveEffective([modeling])
  assert.equal(withoutSubject.groups.length, 0)
  assert.equal(withoutSubject.excluded.find(item => item.entry.id === modeling.id)?.reason, 'subject-not-in-play')
  const withSubject = resolveEffective([modeling], { subjects: ['DeepSeek-Memory'] })
  assert.equal(withSubject.excluded.find(item => item.entry.id === modeling.id)?.reason, 'subject-not-in-play',
    'matching is subject-to-subject, not the project name guessing personal subjects')
  const inPlay = resolveEffective([modeling], { subjects: ['math-modeling'] })
  assert.equal(inPlay.groups.length, 1)
  assert.equal(inPlay.groups[0]!.effective.id, modeling.id)
})

test('distinct keys do not compete', () => {
  const a = card({ key: 'assistant-name', text: 'called 奇米' })
  const b = card({ key: 'search-engine', text: 'Bing first' })
  const { groups } = resolveEffective([a, b])
  assert.equal(groups.length, 2)
})

test('a personal card in a project store is a scope violation', () => {
  const escaped = card({ scope: 'personal-global', key: 'budget', text: 'personal budget note in the repo store' })
  assert.equal(detectScopeViolation(escaped, 'project'), true)
  assert.equal(detectScopeViolation(card({ scope: 'project', text: 'repo convention' }), 'project'), false)
  assert.deepEqual(findScopeViolations([escaped, card({ text: 'fine' })], 'project').map(e => e.id), [escaped.id])
})

test('a project card in the user store is a scope violation', () => {
  const leaked = card({ scope: 'project', text: 'repo convention in the personal store' })
  assert.equal(detectScopeViolation(leaked, 'user'), true)
  assert.equal(detectScopeViolation(card({ scope: 'personal-topic', subject: 'x', text: 'ok' }), 'user'), false)
})

test('a personal-topic card with a project subject is flagged as a suspected escapee', () => {
  // The user's acceptance case: modeling-competition details that belong in a
  // topic card only if the subject is a personal topic. A project-subject card
  // in the user tier with subject 'deepseek-memory' is exactly the kind of
  // write the arbitration view must surface, because the user tier cannot
  // hold project-scoped facts.
  const wrongHome = card({ scope: 'personal-topic', subject: 'deepseek-memory', key: 'ci', text: 'project detail filed under a personal topic' })
  assert.equal(detectScopeViolation(wrongHome, 'user'), false,
    'the tier check is about scope, not subject; subject misuse is a conflict-view concern')
  const { groups } = resolveEffective([wrongHome], { subjects: ['deepseek-memory'] })
  assert.equal(groups.length, 1, 'the card is readable but grouped under a project subject, which the arbitration view renders as suspicious')
})
