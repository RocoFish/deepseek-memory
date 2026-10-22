/**
 * End-to-end wiring tests through the real plugin entry point.
 *
 * Everything else in this suite tests a unit in isolation. These drive `apply()`
 * itself with a fake `ctx`, which is the only way to catch the failures that live
 * in the seams: the turn capture feeding the gate, the `agent/status` trigger, the
 * dispatcher choosing between the child and the fallback, and the degradation
 * paths taken when a service is absent.
 *
 * The `ctx` here is hand-built rather than a real Cordis context, so these tests
 * prove the plugin's own logic and its assumptions about service shapes — not that
 * the live framework matches. `src/typecheck.ts` is what pins those shapes to the
 * published SDK.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import { MEMORY_TOOL_NAMES, type SubagentRunLike, type SubagentStartLike } from '../src/subagent.ts'
import { configFixture } from './fixtures.ts'

const userEvent = (text: string, seq: number) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { content: [{ type: 'text', text }] },
})

const assistantEvent = (text: string, seq: number) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }] } },
})

const routeEvent = (provider: string, model: string) => ({
  type: 'request/header',
  seq: 0,
  time: 1000,
  data: { header: { config: { provider, model } } },
})

/**
 * A fake `ctx` carrying exactly the services the plugin looks up.
 * @param options - which services to omit, and how the subagent service behaves.
 */
function makeCtx(options: {
  omit?: ('subagents' | 'tools' | 'systemPrompt' | 'llm')[]
  /** Called when the plugin starts a child; return the run handle it should see. */
  onChild?: (request: SubagentStartLike) => SubagentRunLike
  /** Text chunks the fake LLM streams back on the fallback path. */
  llmReply?: string
} = {}) {
  const omit = new Set(options.omit ?? [])
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registered: { name: string }[] = []
  const sections: { name: string; text: unknown }[] = []
  const childCalls: SubagentStartLike[] = []
  const disposers: (() => void)[] = []
  let refused = false

  const root = mkdtempSync(join(tmpdir(), 'memory-e2e-'))
  // The project tier lives under the session's directory. Handing the plugin an
  // explicit `cwd` service keeps each test in its own sandbox instead of letting
  // every case share (and contaminate) `<repo>/.dsh-memory`.
  const projectDir = join(root, 'project')

  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    get(key: string) {
      if (key === 'cwd') return projectDir
      if (key === 'tools') {
        if (omit.has('tools')) return undefined
        return {
          register: (definition: { name: string }) => {
            if (refused) throw new Error('registry refused')
            registered.push(definition)
            return () => {}
          },
        }
      }
      if (key === 'systemPrompt') {
        if (omit.has('systemPrompt')) return undefined
        return {
          section: (section: { name: string; text: unknown }) => {
            sections.push(section)
            return () => {}
          },
        }
      }
      if (key === 'subagents') {
        if (omit.has('subagents')) return undefined
        return {
          start: async (_name: string, request: SubagentStartLike): Promise<SubagentRunLike> => {
            childCalls.push(request)
            return options.onChild?.(request) ?? {
              result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'no change', changed: false } }),
              dispose: () => {},
            }
          },
        }
      }
      if (key === 'llm') {
        if (omit.has('llm')) return undefined
        return {
          // eslint-disable-next-line require-yield
          async *stream() {
            yield { delta: { content: options.llmReply ?? '{"actions":[]}' } }
          },
        }
      }
      return undefined
    },
    on(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    inject(_keys: string[], callback: (scoped: unknown) => void) {
      callback(ctx)
      return () => {}
    },
    effect(callback: () => (() => void) | void) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }

  return {
    ctx,
    root,
    registered,
    sections,
    childCalls,
    disposers,
    setRefused(value: boolean) { refused = value },
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
    /** Deliver a session event to every `session/event` listener. */
    emitSession(sessionId: string, event: unknown, cwd = projectDir) {
      const session = { id: sessionId, header: { id: sessionId, cwd } }
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
    /** Deliver an agent/status payload, which is what triggers consolidation. */
    emitStatus(sessionId: string, status: 'idle' | 'running' = 'idle') {
      const agent = { id: sessionId } as unknown as Agent
      for (const listener of listeners.get('agent/status') ?? []) listener({ agent, status })
    },
    /** Render the memory section the plugin registered, if any. */
    renderSection(): string {
      const section = sections.find(entry => entry.name === 'memory')
      if (section === undefined) return ''
      return typeof section.text === 'function' ? (section.text as () => string)() : String(section.text)
    },
  }
}

/** Let queued microtasks and timers settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

/** Run `apply` with plugin logging silenced, then settle. */
async function start(handle: ReturnType<typeof makeCtx>, config = configFixture()) {
  const realLog = console.log
  const realWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  try {
    const previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(handle.root, 'home')
    const dispose = plugin.apply(handle.ctx as never, config)
    await settle()
    return {
      dispose,
      restore: () => {
        if (previousHome === undefined) delete process.env['DSH_HOME']
        else process.env['DSH_HOME'] = previousHome
      },
    }
  } finally {
    console.log = realLog
    console.warn = realWarn
  }
}

test('inject names the services the plugin exists to use', () => {
  // This is not a formality. `inject` is what makes the Cordis service registry
  // reachable: with an empty list `ctx.get(name)` returns undefined for EVERY
  // service, so `apply` runs, finds nothing, and quietly registers neither the
  // prompt section nor a single tool. The plugin then reports as running while
  // doing nothing — which is precisely what shipped, and what this assertion
  // exists to prevent from shipping again.
  //
  // The fake `ctx` used by the tests below hands services over directly and so
  // cannot catch this; it has to be asserted on the export itself.
  assert.ok(plugin.inject.length > 0, 'an empty inject makes the whole service registry unreachable')
  assert.ok(plugin.inject.includes('tools'), '`tools` must be injected or the memory tools are never registered')
  assert.ok(plugin.inject.includes('systemPrompt'), '`systemPrompt` must be injected or memory is never injected')
})

test('apply registers the memory tools and the prompt section', async () => {
  const handle = makeCtx()
  const started = await start(handle)
  try {
    assert.equal(plugin.name, 'memory')
    assert.deepEqual(handle.registered.map(tool => tool.name).sort(), [...MEMORY_TOOL_NAMES].sort())
    assert.equal(handle.sections.length, 1)
    assert.equal(handle.sections[0]!.name, 'memory')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('the prompt section reflects memory written after the section was registered', async () => {
  const handle = makeCtx()
  const started = await start(handle)
  try {
    // The section is a provider, so it must be recomputed on every assembly.
    // A snapshot would not show an entry added afterwards.
    assert.equal(handle.renderSection(), '', 'an empty store contributes nothing')

    const tools = handle.registered.find(tool => (tool as { name: string }).name === 'memory_add') as unknown as {
      execute: (args: { text: string; tier?: string }) => Promise<string>
    }
    await tools.execute({ text: 'the build uses tsc', tier: 'project' })

    const rendered = handle.renderSection()
    assert.match(rendered, /the build uses tsc/, 'a later write must appear without re-registering')
    assert.match(rendered, /<system-reminder>/)
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('a closed turn with a durable signal starts a narrowed child agent', async () => {
  const handle = makeCtx()
  const started = await start(handle)
  try {
    handle.emitSession('session-1', routeEvent('deepseek-official', 'deepseek-flash'))
    handle.emitSession('session-1', userEvent('记住我们的构建用 tsc，不要用打包器', 1))
    handle.emitSession('session-1', assistantEvent('好，已记下。', 2))
    handle.emitStatus('session-1')
    await settle()

    assert.equal(handle.childCalls.length, 1, 'one child should have been started')
    const request = handle.childCalls[0]!
    assert.deepEqual(request.toolFilter, { allow: [...MEMORY_TOOL_NAMES] },
      'the child must be narrowed to the memory tools')
    const promptText = (request.prompt as { text: string }[])[0]!.text
    assert.match(promptText, /Current memory/)
    assert.match(promptText, /记住我们的构建用 tsc/,
      'the child must receive the turn that triggered consolidation')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('minTurnsBetweenRuns spaces two runs by whole closed turns', async () => {
  const handle = makeCtx()
  const started = await start(handle, configFixture({ minTurnsBetweenRuns: 2 }))
  try {
    const turn = (seqBase: number) => {
      handle.emitSession('session-1', userEvent('记住我们的构建用 tsc', seqBase))
      handle.emitSession('session-1', assistantEvent('好。', seqBase + 1))
      handle.emitStatus('session-1')
      return settle()
    }

    await turn(1)
    assert.equal(handle.childCalls.length, 1, 'the first run may happen immediately')

    await turn(10)
    assert.equal(handle.childCalls.length, 1, 'only one closed turn has passed since the run; no second run yet')

    await turn(20)
    assert.equal(handle.childCalls.length, 2, 'two closed turns have passed since the run; it may run again')

    await turn(30)
    assert.equal(handle.childCalls.length, 2, 'the interval restarts from each run, not from the session start')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('a closed turn with no durable signal starts nothing at all', async () => {
  const handle = makeCtx()
  const started = await start(handle)
  try {
    handle.emitSession('session-1', userEvent('帮我看下这个函数', 1))
    handle.emitSession('session-1', assistantEvent('好的。', 2))
    handle.emitStatus('session-1')
    await settle()

    assert.equal(handle.childCalls.length, 0,
      'the gate must stop an uninteresting turn before any model cost is incurred')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('without a subagent provider the turn still consolidates, via the fallback path', async () => {
  const handle = makeCtx({ omit: ['subagents'], llmReply: '{"actions":[{"op":"add","tier":"project","text":"the build uses tsc"}]}' })
  const started = await start(handle)
  try {
    handle.emitSession('session-1', routeEvent('deepseek-official', 'deepseek-flash'))
    handle.emitSession('session-1', userEvent('记住我们的构建用 tsc', 1))
    handle.emitSession('session-1', assistantEvent('好。', 2))
    handle.emitStatus('session-1')
    await settle()

    assert.equal(handle.childCalls.length, 0, 'no child service, so no child')
    // The fallback applied the change through the same store the tools read.
    const rendered = handle.renderSection()
    assert.match(rendered, /the build uses tsc/,
      'the fallback must be able to write memory when no subagent provider exists')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('without an LLM and without subagents the turn is simply skipped', async () => {
  const handle = makeCtx({ omit: ['subagents', 'llm'] })
  const started = await start(handle)
  try {
    handle.emitSession('session-1', userEvent('记住我们的构建用 tsc', 1))
    handle.emitSession('session-1', assistantEvent('好。', 2))
    handle.emitStatus('session-1')
    await settle()
    assert.equal(handle.childCalls.length, 0)
    assert.equal(handle.renderSection(), '', 'nothing may be invented without a model')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('consolidation: off disables the whole path', async () => {
  const handle = makeCtx()
  const started = await start(handle, configFixture({ consolidation: 'off' }))
  try {
    handle.emitSession('session-1', userEvent('记住我们的构建用 tsc', 1))
    handle.emitSession('session-1', assistantEvent('好。', 2))
    handle.emitStatus('session-1')
    await settle()
    assert.equal(handle.childCalls.length, 0)
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('a refused tool registration does not stop the plugin from loading', async () => {
  const handle = makeCtx()
  handle.setRefused(true)
  const started = await start(handle)
  try {
    assert.equal(handle.registered.length, 0, 'the registry refused every definition')
    // And the injection path is unaffected, which is the point of not hard-failing.
    handle.emitSession('session-1', userEvent('x', 1))
    assert.equal(typeof handle.renderSection(), 'string')
  } finally { started.restore(); started.dispose(); handle.cleanup() }
})

test('apply survives a context whose services all throw', async () => {
  const realLog = console.log
  const realWarn = console.warn
  console.log = () => {}
  console.warn = () => {}
  const scratch = mkdtempSync(join(tmpdir(), 'memory-hostile-'))
  try {
    const hostile = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      // `cwd` answers, so the project tier lands in the scratch directory rather
      // than in whatever directory this test happens to run from.
      get(key: string) {
        if (key === 'cwd') return scratch
        throw new Error('service store exploded')
      },
      on() { throw new Error('event bus exploded') },
      inject() { throw new Error('inject exploded') },
      effect() { throw new Error('effect exploded') },
    }
    // A convenience plugin must never be able to fail the shell's plugin load.
    const dispose = plugin.apply(hostile as never, configFixture())
    assert.equal(typeof dispose, 'function', 'a failed load still returns a disposer')
    dispose()
  } finally {
    console.log = realLog
    console.warn = realWarn
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('disposal stops the plugin from reacting to later events', async () => {
  const handle = makeCtx()
  const started = await start(handle)
  started.dispose()
  started.restore()
  try {
    handle.emitSession('session-1', userEvent('记住我们的构建用 tsc', 1))
    handle.emitSession('session-1', assistantEvent('好。', 2))
    handle.emitStatus('session-1')
    await settle()
    assert.equal(handle.childCalls.length, 0, 'a disposed plugin must be inert')
  } finally { handle.cleanup() }
})
