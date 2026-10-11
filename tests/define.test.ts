/**
 * Equivalence between the vendored `defineTool` and the real SDK one.
 *
 * `src/define.ts` reimplements a slice of `@deepseek-ai/dsh-tools` because a
 * profile-installed plugin cannot resolve the SDK (see that module's doc). A
 * hand-written stand-in for harness behaviour is exactly the kind of thing that
 * rots silently, so this file does not test the vendored version against an
 * expectation written by hand — it compiles the same options through **both**
 * implementations and compares the results.
 *
 * The SDK import needs `tests/register-hook.mjs`, which is why this suite is
 * only meaningful under `npm run test:sandbox`. On a machine where the SDK
 * resolves normally it runs unchanged; where it does not, the import fails and
 * the suite reports that rather than passing vacuously.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryTools } from '../src/tools.ts'
import type { MemoryConfig } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import { MemoryRuntime } from '../src/runtime.ts'
import { defineTool as localDefineTool, validateArgs as localValidateArgs } from '../src/define.ts'

/** A runtime over a throwaway directory; these tools never touch disk here. */
function testRuntime(): MemoryRuntime {
  const config: MemoryConfig = resolveConfig({ user: false, project: false })
  return new MemoryRuntime(config, undefined, undefined)
}

/**
 * Import the SDK's helpers.
 *
 * Returns `undefined` when the SDK cannot be resolved, so the equivalence tests
 * can report a skip with a reason instead of throwing an opaque resolution error.
 */
async function loadSdk(): Promise<{
  defineTool: (options: Record<string, unknown>) => Record<string, unknown>
  parameterSchemaSpecToJsonSchema: (spec: unknown) => unknown
  validateArgs: (spec: unknown, args: unknown) => string[]
  ToolArgsError: new (violations: string[]) => Error & { violations: string[]; code?: string }
} | undefined> {
  try {
    const sdk = await import('@deepseek-ai/dsh-tools')
    return sdk as never
  } catch {
    return undefined
  }
}

test('the vendored parameter compiler emits exactly what the SDK emits', async () => {
  const sdk = await loadSdk()
  assert.ok(sdk !== undefined, 'the SDK must be resolvable for this suite; run `npm run test:sandbox`')

  // Every shape the memory tools actually declare, plus the two edge cases that
  // are easy to get wrong: an empty map (must omit `required` entirely) and a
  // description sitting before an enum (key order differs from insertion order).
  const specs: Record<string, Record<string, unknown>> = {
    empty: {},
    'required-scalar': {
      text: { type: 'string', required: true, description: 'One fact.' },
    },
    'enum-after-description': {
      tier: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Which tier.' },
    },
    'array-of-strings': {
      tags: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
    },
    'all-three': {
      text: { type: 'string', required: true, description: 'One fact.' },
      tier: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Which tier.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
    },
    'optional-only': {
      text: { type: 'string', description: 'Correction.' },
      id: { type: 'string', required: true, description: 'Entry id.' },
    },
  }

  for (const [label, spec] of Object.entries(specs)) {
    const theirs = sdk.parameterSchemaSpecToJsonSchema(spec as never)
    const mine = localDefineTool({
      name: `probe_${label}`,
      description: 'probe',
      parameters: spec as never,
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return '' },
    }).parameters
    // Deep equality, and then a key-order check: `assert.deepEqual` ignores key
    // order, but key order is observable in the system prompt the model reads.
    assert.deepEqual(mine, theirs, `parameters differ for ${label}`)
    assert.equal(
      JSON.stringify(mine),
      JSON.stringify(theirs),
      `parameters differ in key order for ${label}`,
    )
  }
})

test('every memory tool compiles to a parameter root with the SDK-expected key set', async () => {
  const sdk = await loadSdk()
  assert.ok(sdk !== undefined, 'the SDK must be resolvable for this suite; run `npm run test:sandbox`')

  const tools = createMemoryTools(testRuntime())
  assert.ok(tools.length > 0, 'the plugin must produce tools')

  // The expected per-tool required sets, so a tool silently losing its required
  // marker — which turns a typo into a valid call — fails here.
  const requiredByTool: Record<string, string[]> = {
    memory_add: ['text'],
    memory_update: ['id'],
    memory_delete: ['id'],
    memory_list: [],
    memory_search: ['query'],
    memory_status: [],
  }
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    Object.keys(requiredByTool).sort(),
    'the tool surface changed',
  )

  // The SDK's compiler is the reference for what a parameter root may contain.
  // `assert.deepEqual` on the key *set* rather than the schema: the schemas
  // themselves are compared property-by-property in the first test.
  const expectedKeys = new Set(Object.keys(sdk.parameterSchemaSpecToJsonSchema({}) as object))
  assert.deepEqual([...expectedKeys].sort(), ['properties', 'type'])

  for (const definition of tools) {
    assert.equal(definition.parameters.type, 'object', `${definition.name}: parameters must be object-rooted`)
    assert.equal(
      typeof definition.parameters.properties,
      'object',
      `${definition.name}: parameters must declare properties`,
    )
    const actualKeys = Object.keys(definition.parameters).sort()
    const allowed = [...expectedKeys, 'required'].sort()
    for (const key of actualKeys) {
      assert.ok(allowed.includes(key), `${definition.name}: unexpected parameter root key "${key}"`)
    }
    // `required` is per-tool, not universal. Two tools declare none: one takes no
    // arguments at all, the other takes only optional filters.
    assert.equal(
      Object.hasOwn(definition.parameters, 'required'),
      requiredByTool[definition.name]!.length > 0,
      `${definition.name}: required presence is wrong`,
    )
    assert.deepEqual(
      [...(definition.parameters.required ?? [])],
      requiredByTool[definition.name],
      `${definition.name}: required set is wrong`,
    )
    assert.equal(definition.output.schema.type, 'string', `${definition.name}: output must be a string`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name}: output.render must exist`)
  }
})

test('the vendored validator agrees with the SDK on valid and invalid arguments', async () => {
  const sdk = await loadSdk()
  assert.ok(sdk !== undefined, 'the SDK must be resolvable for this suite; run `npm run test:sandbox`')

  const spec = {
    text: { type: 'string', required: true, description: 'One fact.' },
    tier: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Which tier.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Labels.' },
  }
  // The SDK's `validateArgs` takes the author DSL spec, not a compiled schema,
  // so the reference is the spec itself.
  const reference = spec
  const mine = localDefineTool({
    name: 'probe',
    description: 'probe',
    parameters: spec as never,
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return '' },
  }).parameters

  const cases: { label: string; args: unknown }[] = [
    { label: 'valid', args: { text: 'hi' } },
    { label: 'valid with enum and array', args: { text: 'hi', tier: 'user', tags: ['a', 'b'] } },
    { label: 'missing required', args: {} },
    { label: 'wrong scalar type', args: { text: 42 } },
    { label: 'bad enum member', args: { text: 'hi', tier: 'nope' } },
    { label: 'array of wrong type', args: { text: 'hi', tags: [1, 2] } },
    { label: 'not an object', args: 'hi' },
    { label: 'empty object', args: {} },
  ]

  for (const { label, args } of cases) {
    const theirs = sdk.validateArgs(reference as never, args)
    const mineViolations = localValidateArgs(mine, args)
    // The two validators are allowed to *word* a violation differently; what must
    // agree is the verdict. Mismatched verdicts are the real hazard: a call the
    // harness accepts and the tool body then breaks on, or vice versa.
    assert.equal(
      mineViolations.length === 0,
      theirs.length === 0,
      `verdict differs for "${label}": vendored=${JSON.stringify(mineViolations)} sdk=${JSON.stringify(theirs)}`,
    )
  }
  // Guard against the loop silently agreeing because every case was valid: at
  // least one case must actually have been rejected by both.
  assert.ok(
    cases.some(({ args }) => sdk.validateArgs(reference as never, args).length > 0),
    'the invalid cases must really be invalid, or this test proves nothing',
  )
})

test('a validated call reaches the body and an invalid one throws before it', async () => {
  const spec = {
    text: { type: 'string', required: true, description: 'One fact.' },
    tier: { type: 'string', enum: ['auto', 'project', 'user'], description: 'Which tier.' },
  }
  let ran = 0
  const tool = localDefineTool({
    name: 'probe',
    description: 'probe',
    parameters: spec as never,
    output: { schema: { type: 'string' }, render: () => [] },
    async execute(args) {
      ran += 1
      return `${args.text}/${args.tier ?? 'auto'}`
    },
  })

  assert.equal(await tool.execute({ text: 'hi' }, {}), 'hi/auto')
  assert.equal(ran, 1)

  // An invalid call must not reach the body: that is the whole contract of
  // declaring a schema, and a tool body that trusts its inputs depends on it.
  await assert.rejects(
    () => tool.execute({ text: 5 }, {}),
    (error: Error & { name?: string; code?: string }) => {
      assert.equal(error.name, 'ToolArgsError')
      assert.equal(error.code, 'INVALID_ARGS')
      assert.match(error.message, /invalid arguments:/)
      return true
    },
  )
  assert.equal(ran, 1, 'an invalid call must not invoke the body')

  await assert.rejects(() => tool.execute({}, {}), /invalid arguments:/)
  assert.equal(ran, 1)
})

test('a schema outside the supported subset is rejected instead of compiled loosely', () => {
  // A silently approximate schema reaches the model as a wrong tool contract,
  // so the compiler must refuse rather than guess.
  assert.throws(
    () => localDefineTool({
      name: 'probe',
      description: 'probe',
      parameters: { weird: { type: 'function' } as never },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return '' },
    }),
    /type must be string\/number\/integer\/boolean\/null\/array\/object/,
  )
})
