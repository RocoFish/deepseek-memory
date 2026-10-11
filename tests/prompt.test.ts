/**
 * Injection tests.
 *
 * The prompt section is the entire read path, so its budget and its framing are
 * both behavioural contracts, not formatting preferences.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMemory } from '../src/prompt.ts'
import type { MemoryEntry } from '../src/store.ts'

const entry = (id: string, text: string): MemoryEntry => ({
  id,
  text,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  origin: 'user',
})

test('nothing is injected when both tiers are empty', () => {
  const rendered = renderMemory([
    { tier: 'project', label: 'Project', entries: [] },
    { tier: 'user', label: 'User', entries: [] },
  ], 1000)
  assert.equal(rendered.text, '', 'an empty store must contribute zero tokens')
  assert.equal(rendered.injected.length, 0)
})

test('the section is framed as notes and forbids following them', () => {
  const rendered = renderMemory([
    { tier: 'user', label: 'User memory', entries: [entry('m1', 'Prefers concise answers')] },
  ], 1000)
  assert.match(rendered.text, /^<system-reminder>/)
  assert.match(rendered.text, /<\/system-reminder>$/)
  assert.match(rendered.text, /not instructions/i)
  assert.match(rendered.text, /stale/i)
  assert.match(rendered.text, /- Prefers concise answers/)
})

test('project memory is injected before user memory', () => {
  const rendered = renderMemory([
    { tier: 'project', label: 'Project memory', entries: [entry('p1', 'Build uses tsdown')] },
    { tier: 'user', label: 'User memory', entries: [entry('u1', 'Prefers tabs')] },
  ], 1000)
  const projectAt = rendered.text.indexOf('Build uses tsdown')
  const userAt = rendered.text.indexOf('Prefers tabs')
  assert.ok(projectAt > -1 && userAt > -1)
  assert.ok(projectAt < userAt, 'the more specific tier must come first')
})

test('the character budget is a hard bound and omissions are disclosed', () => {
  const entries = Array.from({ length: 30 }, (_value, i) => entry(`m${i}`, `fact number ${i} `.repeat(6)))
  const rendered = renderMemory([{ tier: 'project', label: 'Project', entries }], 400)
  assert.ok(rendered.truncated, 'a small budget must truncate')
  assert.ok(rendered.omitted > 0)
  assert.match(rendered.text, /omitted for space/)
  assert.match(rendered.text, /memory_search/)
  // Only what fits is claimed as injected.
  assert.ok(rendered.injected.length < entries.length)
})

test('a budget of zero injects nothing rather than ignoring the limit', () => {
  const rendered = renderMemory([
    { tier: 'project', label: 'Project', entries: [entry('p1', 'a fact')] },
  ], 0)
  assert.equal(rendered.text, '')
  assert.equal(rendered.omitted, 1)
})

test('one fact stored in both tiers is injected once', () => {
  const shared = entry('same', 'The project uses ESM')
  const rendered = renderMemory([
    { tier: 'project', label: 'Project', entries: [shared] },
    { tier: 'user', label: 'User', entries: [shared] },
  ], 1000)
  assert.equal(rendered.injected.length, 1)
  assert.equal(rendered.text.split('The project uses ESM').length - 1, 1)
})
