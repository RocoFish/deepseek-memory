/**
 * The restricted child agent that performs memory consolidation.
 *
 * Why a child agent rather than a bare model call: consolidation is a reasoning
 * task over a transcript, and the harness already has a construct for "a separate
 * agent with its own context and its own narrowed authority". Using it buys three
 * things a hand-rolled single request cannot:
 *
 * - **Real narrowing.** `toolFilter` removes every tool but the memory ones from
 *   the child's prompt *and* refuses them at execution, so the child cannot read
 *   or write the repository no matter what the transcript talks it into.
 * - **No parent history.** The child starts fresh, so consolidation never inflates
 *   the main conversation's tokens, and a noisy turn cannot leak into it.
 * - **A structured receipt.** `outputSchema` makes the child return a report the
 *   plugin can compare against what actually changed.
 *
 * The child writes the store through the plugin's own registered memory tools, so
 * every ceiling and every teaching error still applies. That is why the plugin
 * does not trust the child's self-report: it compares store revisions across the
 * run instead.
 *
 * @module deepseek-memory/subagent
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from './define.ts'
import { assertObjectJsonSchema } from './define.ts'
import type { MemoryRuntime } from './runtime.ts'
import type { MemoryTier } from './store.ts'

/** Names of the tools this plugin registers. The child is filtered to exactly these. */
export const MEMORY_TOOL_NAMES = [
  'memory_add',
  'memory_update',
  'memory_delete',
  'memory_list',
  'memory_search',
  'memory_status',
] as const

/**
 * The slice of `SubagentRuntime` this plugin uses.
 *
 * Declared structurally and deliberately narrow. The plugin depends on one method
 * with one documented request shape, so it needs neither a hard dependency on the
 * subagent package nor the ability to configure anything else about the child.
 * `subagent-types.ts` asserts that the real service satisfies this.
 */
export interface SubagentConsolidator {
  /**
   * Establish a published child on the named provider.
   * @param name - the registered provider name.
   * @param request - label, prompt, parent, signal, and the optional narrowing knobs.
   * @returns the published run, whose result settles when the child finishes.
   */
  start(name: string, request: SubagentStartLike): Promise<SubagentRunLike>
}

/** The request fields this plugin sets. Mirrors `SubagentStartRequest`. */
export interface SubagentStartLike {
  readonly label?: string
  /**
   * Mutable array, matching `SubagentStartRequest.prompt` exactly. Declaring it
   * `readonly` reads better but makes this interface *narrower* in the wrong
   * direction: a function accepting the real request would then not accept this
   * one, and the conformance check in `typecheck.ts` fails.
   */
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
  readonly outputSchema?: ObjectJsonSchema
}

/** The run handle this plugin uses. Mirrors `SubagentRun`. */
export interface SubagentRunLike {
  readonly result: Promise<{ readonly stopReason: string; readonly structured?: unknown; readonly diagnostic?: string }>
  dispose(): void | Promise<void>
}

/**
 * The child's required report shape.
 *
 * Deliberately minimal: the child is asked what it *did*, not to restate the
 * store. The authoritative record is the store itself, which the plugin reads
 * before and after the run.
 */
export const CONSOLIDATION_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'One sentence describing what changed in memory, or "no change" when nothing was worth keeping.',
    },
    changed: {
      type: 'boolean',
      description: 'True when at least one memory entry was added, updated, or deleted.',
    },
  },
  required: ['summary', 'changed'],
}

/**
 * Check the child's output schema against the enforced JSON Schema subset.
 *
 * The SDK export is reached by dynamic `import()` rather than a top-level value
 * import so the built output carries no bare specifier: a profile-installed
 * plugin cannot resolve `@deepseek-ai/*`, and a hard import would take the whole
 * plugin — prompt injection included — down with it.
 *
 * The check itself is local (`./define.ts`) rather than the SDK's, because the
 * dynamic import is exactly the dependency this package is built to avoid: on a
 * real profile install it fails, so a validation that needs it is a validation
 * that never runs. What the local check asserts is structural self-consistency
 * of a schema this module owns — object root, supported node types, `required`
 * naming declared properties — not parity with the harness's own checker.
 *
 * A failure is a bug to report, not a reason to refuse to consolidate.
 */
function assertSchemaSupported(schema: ObjectJsonSchema, warn: (message: string) => void): void {
  try {
    assertObjectJsonSchema(schema)
  } catch (error) {
    warn(`the consolidator output schema is not self-consistent: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The child's persona, replacing the deployment persona for this child alone. */
export const CONSOLIDATOR_PERSONA = `You maintain a small long-term memory store for an AI coding assistant. You are not the assistant the user was talking to: you have no task of your own except keeping memory accurate.

Decide whether anything in the turn you are shown is worth remembering long-term, and use the memory tools to apply exactly those changes.

Rules:
- Memory holds durable facts: who the user is, standing preferences, project conventions, decisions, and constraints worth not rediscovering.
- Never store transient task state, file contents, code, command output, secrets, tokens, or anything the user asked to forget.
- Prefer few, high-value entries. Most turns deserve no change at all.
- One fact per entry, at most a sentence or two.
- Use memory_update when a fact changed or an existing entry is wrong; memory_delete when an entry is obsolete and nothing replaces it; memory_add only for genuinely new facts.
- "project" is for this repository's conventions; "user" is for facts about the person.
- Call memory_list first if you need the current entries and their ids.
- You have no other tools. If a change needs the filesystem or a command, it does not belong in memory.

When you are done, report what you changed.`

/** What one child run did. */
export interface ChildConsolidationOutcome {
  /** Whether the child ran to a completed stop reason. */
  readonly completed: boolean
  /** The child's own one-line account, when it produced one. */
  readonly summary: string
  /** Whether the child claimed a change. */
  readonly claimedChange: boolean
  /** Store revisions before and after, which is what the plugin actually trusts. */
  readonly revisionBefore: number
  readonly revisionAfter: number
  /** Whether the store actually moved. */
  readonly changed: boolean
  /** Provider diagnostic for a non-completed run. */
  readonly diagnostic?: string
}

/** Render the turn for the child's prompt. */
function renderPrompt(transcript: string, store: string): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      '## Current memory',
      store,
      '',
      '## The turn that just ended',
      transcript,
    ].join('\n'),
  }]
}

/** Render the current store for the child's prompt. */
function renderStore(runtime: MemoryRuntime): string {
  const parts: string[] = []
  for (const tier of runtime.enabledTiers()) {
    const entries = runtime.list(tier)
    parts.push(`### ${tier} (${entries.length} entries)`)
    if (entries.length === 0) parts.push('(empty)')
    else for (const entry of entries) parts.push(`${entry.id}: ${entry.text}`)
    parts.push('')
  }
  return parts.join('\n').trimEnd() || '(no tier enabled)'
}

/** Sum the live entry count across every enabled tier. */
function totalEntries(runtime: MemoryRuntime): number {
  return runtime.enabledTiers().reduce((sum, tier) => sum + runtime.store(tier).size, 0)
}

/** Read the `summary`/`changed` pair out of whatever the child returned. */
function readReceipt(structured: unknown): { summary: string; changed: boolean } {
  if (structured === null || typeof structured !== 'object') return { summary: '', changed: false }
  const record = structured as Record<string, unknown>
  return {
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    changed: record['changed'] === true,
  }
}

/**
 * Run one consolidation as a restricted child agent.
 *
 * @param deps - the subagent service, the store owner, and logging.
 * @param input - the child's prompt material and the spawning agent.
 * @returns what the child did, including whether the store actually moved.
 */
export async function runChildConsolidation(
  deps: {
    readonly subagents: SubagentConsolidator
    readonly provider: string
    readonly runtime: MemoryRuntime
    readonly log: (message: string) => void
    readonly warn: (message: string) => void
  },
  input: {
    readonly parent: Agent
    readonly transcript: string
    readonly signal: AbortSignal
  },
): Promise<ChildConsolidationOutcome> {
  // Snapshot the authoritative state before the child exists: this, not the
  // child's own report, is what proves a change happened.
  assertSchemaSupported(CONSOLIDATION_OUTPUT_SCHEMA, deps.warn)
  const revisionBefore = deps.runtime.enabledTiers()
    .reduce((sum, tier) => sum + deps.runtime.store(tier).revision, 0)
  const entriesBefore = totalEntries(deps.runtime)

  const run = await deps.subagents.start(deps.provider, {
    label: 'memory consolidation',
    prompt: renderPrompt(input.transcript, renderStore(deps.runtime)),
    parent: input.parent,
    signal: input.signal,
    // The whole point of using a child: it can reach nothing but memory.
    toolFilter: { allow: [...MEMORY_TOOL_NAMES] },
    persona: CONSOLIDATOR_PERSONA,
    outputSchema: CONSOLIDATION_OUTPUT_SCHEMA,
  })

  try {
    const result = await run.result
    // Read the SAME store objects the child wrote through: its tool calls mutated
    // this runtime in-process, so the cache is already authoritative. Calling
    // `refresh()` here would be actively wrong — it drops every clean store and
    // re-reads from disk, which can fail on a file the child just touched.
    const revisionAfter = deps.runtime.enabledTiers()
      .reduce((sum, tier) => sum + deps.runtime.store(tier).revision, 0)
    const entriesAfter = totalEntries(deps.runtime)
    const receipt = readReceipt(result.structured)
    const changed = revisionAfter !== revisionBefore || entriesAfter !== entriesBefore

    if (receipt.changed && !changed) {
      // A child that reports a change it did not make is the failure mode worth
      // shouting about: it means the receipt cannot be trusted as evidence.
      deps.warn(`consolidator reported a change but the store did not move (${receipt.summary || 'no summary'})`)
    }
    if (result.stopReason !== 'completed') {
      deps.warn(`consolidator ended with ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`)
    }

    return {
      completed: result.stopReason === 'completed',
      summary: receipt.summary,
      claimedChange: receipt.changed,
      revisionBefore,
      revisionAfter,
      changed,
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    }
  } finally {
    // A run is one disposable delegation; always release it to reach quiescence.
    try {
      await run.dispose()
    } catch (error) {
      deps.warn(`consolidator disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Which tiers participated, for diagnostics. */
export function tiersUsed(runtime: MemoryRuntime): MemoryTier[] {
  return runtime.enabledTiers()
}
