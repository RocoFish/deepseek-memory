/**
 * Restricted-child consolidation tests.
 *
 * The child is the primary consolidation path, so its two promises are pinned
 * here: it can reach nothing but the memory tools, and it cannot make the plugin
 * believe something the store does not show.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CONSOLIDATION_OUTPUT_SCHEMA,
  CONSOLIDATOR_PERSONA,
  MEMORY_TOOL_NAMES,
  runChildConsolidation,
  type SubagentRunLike,
  type SubagentStartLike,
} from '../src/subagent.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { configFixture } from './fixtures.ts'

/** A fake subagent service that records what it was asked for. */
function fakeSubagents(behaviour: (request: SubagentStartLike) => Promise<SubagentRunLike>) {
  const calls: { name: string; request: SubagentStartLike }[] = []
  return {
    calls,
    service: {
      async start(name: string, request: SubagentStartLike): Promise<SubagentRunLike> {
        calls.push({ name, request })
        return behaviour(request)
      },
    },
  }
}

/** A run handle that settles with a given result and records disposal. */
function runReturning(result: { stopReason: string; structured?: unknown; diagnostic?: string }) {
  let disposed = false
  return {
    handle: {
      result: Promise.resolve(result),
      dispose: () => { disposed = true },
    } satisfies SubagentRunLike,
    wasDisposed: () => disposed,
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'memory-child-'))
  const runtime = new MemoryRuntime(configFixture(), join(root, 'home'), join(root, 'project'), () => 1000)
  return { runtime, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

const parent = { id: 'session-1' } as unknown as Agent
const deps = (runtime: MemoryRuntime, service: ReturnType<typeof fakeSubagents>['service']) => ({
  subagents: service,
  provider: 'in-process',
  runtime,
  log: () => {},
  warn: () => {},
})

test('the child is narrowed to exactly the memory tools', async () => {
  const box = sandbox()
  try {
    const fake = fakeSubagents(async () => runReturning({ stopReason: 'completed' }).handle)
    await runChildConsolidation(deps(box.runtime, fake.service), {
      parent,
      transcript: 'user: 记住我用 pnpm',
      signal: new AbortController().signal,
    })

    assert.equal(fake.calls.length, 1)
    const { name, request } = fake.calls[0]!
    assert.equal(name, 'in-process')
    assert.deepEqual(request.toolFilter, { allow: [...MEMORY_TOOL_NAMES] },
      'the child must be allowed the memory tools and nothing else')
    // A deny list would be weaker: a tool registered later could slip through.
    assert.equal((request.toolFilter as { deny?: unknown }).deny, undefined)
  } finally { box.cleanup() }
})

test('the child gets its own persona, a structured receipt, and the store in its prompt', async () => {
  const box = sandbox()
  try {
    box.runtime.store('project').add({ text: 'the build uses tsc', origin: 'user', now: 1 })
    const fake = fakeSubagents(async () => runReturning({ stopReason: 'completed' }).handle)
    await runChildConsolidation(deps(box.runtime, fake.service), {
      parent,
      transcript: 'user: 我们约定构建用 tsc',
      signal: new AbortController().signal,
    })

    const { request } = fake.calls[0]!
    assert.equal(request.persona, CONSOLIDATOR_PERSONA)
    assert.deepEqual(request.outputSchema, CONSOLIDATION_OUTPUT_SCHEMA)
    assert.equal(request.parent, parent)
    const promptText = (request.prompt as { type: string; text: string }[])[0]!.text
    assert.match(promptText, /Current memory/)
    assert.match(promptText, /the build uses tsc/, 'the child must see the entries it may rewrite')
    assert.match(promptText, /我们约定构建用 tsc/, 'the child must see the turn it is judging')
  } finally { box.cleanup() }
})

test('a run is always disposed, even when it fails', async () => {
  const box = sandbox()
  try {
    let disposed = false
    const fake = fakeSubagents(async (): Promise<SubagentRunLike> => ({
      result: Promise.reject(new Error('provider exploded')),
      dispose: () => { disposed = true },
    }))
    await assert.rejects(
      runChildConsolidation(deps(box.runtime, fake.service), {
        parent,
        transcript: 'x',
        signal: new AbortController().signal,
      }),
      /provider exploded/,
    )
    assert.equal(disposed, true, 'a rejected run must still be released')
  } finally { box.cleanup() }
})

test('the plugin detects a change by revision, not by the child self-report', async () => {
  const box = sandbox()
  try {
    // The child claims a change but writes nothing: the store must win.
    const fake = fakeSubagents(async () => runReturning({
      stopReason: 'completed',
      structured: { summary: 'added a preference', changed: true },
    }).handle)

    const outcome = await runChildConsolidation(deps(box.runtime, fake.service), {
      parent,
      transcript: 'user: 记住我喜欢简洁',
      signal: new AbortController().signal,
    })
    assert.equal(outcome.claimedChange, true)
    assert.equal(outcome.changed, false, 'an unchanged store must not be reported as changed')
    assert.equal(outcome.revisionAfter, outcome.revisionBefore)
  } finally { box.cleanup() }
})

test('a change the child really made through the store is observed', async () => {
  const box = sandbox()
  try {
    // Simulate what the child's tool call does: mutate the same runtime.
    const fake = fakeSubagents(async () => {
      box.runtime.store('project').add({ text: 'the user prefers concise answers', origin: 'consolidator', now: 5 })
      box.runtime.commit('project')
      return runReturning({ stopReason: 'completed', structured: { summary: 'added a preference', changed: true } }).handle
    })

    const outcome = await runChildConsolidation(deps(box.runtime, fake.service), {
      parent,
      transcript: 'user: 记住我喜欢简洁',
      signal: new AbortController().signal,
    })
    assert.equal(outcome.changed, true)
    assert.ok(outcome.revisionAfter > outcome.revisionBefore)
    assert.equal(outcome.completed, true)
  } finally { box.cleanup() }
})

test('a non-completed child surfaces its diagnostic and is not treated as success', async () => {
  const box = sandbox()
  try {
    const fake = fakeSubagents(async () => runReturning({
      stopReason: 'error',
      diagnostic: 'child exceeded its context',
    }).handle)
    const outcome = await runChildConsolidation(deps(box.runtime, fake.service), {
      parent,
      transcript: 'x',
      signal: new AbortController().signal,
    })
    assert.equal(outcome.completed, false)
    assert.equal(outcome.diagnostic, 'child exceeded its context')
  } finally { box.cleanup() }
})

test('the output schema is a valid object-rooted schema and the allow list is exact', () => {
  // The schema is validated by `assertObjectJsonSchema` at module load, so
  // importing this module at all is the assertion; these checks pin the intent.
  assert.equal(CONSOLIDATION_OUTPUT_SCHEMA['type'], 'object')
  assert.deepEqual(CONSOLIDATION_OUTPUT_SCHEMA['required'], ['summary', 'changed'])
  assert.equal(CONSOLIDATION_OUTPUT_SCHEMA['additionalProperties'], false)
  assert.equal(MEMORY_TOOL_NAMES.length, 6)
  assert.ok(MEMORY_TOOL_NAMES.every(tool => tool.startsWith('memory_')))
})
