/**
 * The model-facing memory tools.
 *
 * Written against the published `defineTool` API (`@deepseek-ai/dsh-tools`), not
 * a hand-rolled definition: the registry validates model arguments against these
 * schemas before `execute` runs, so the bodies can trust their inputs, and the
 * schemas reach the system prompt through the normal tool view.
 *
 * Every refusal is a `MemoryError` carrying text the model can act on. The
 * registry turns a throw into a failed call, so the teaching text lands in the
 * transcript where the next step can read it.
 *
 * @module deepseek-memory/tools
 */
import type { InferArgs, ParameterSchemaSpec, ToolDefinition } from './define.ts'
import { defineTool } from './define.ts'
import type { MemoryEntry, MemoryTier } from './store.ts'
import { MemoryError } from './store.ts'
import type { MemoryRuntime } from './runtime.ts'

/** Tools accept an explicit tier, or `auto` to pick the most specific live one. */
export type TierChoice = MemoryTier | 'auto'

/**
 * Resolve the tier a tool call targets.
 *
 * `auto` prefers the project tier whenever it is enabled and the session has a
 * cwd, because in a coding harness a repository convention is nearly always the
 * more specific fact. Personal facts still belong in the user tier, which the
 * model selects explicitly.
 *
 * The argument is typed as a plain string on purpose. The registry validates it
 * against the declared enum before `execute` runs, but a definition is also
 * reachable from Code Mode and from tests, so an unexpected value must produce a
 * teaching error rather than be trusted.
 */
function resolveTier(runtime: MemoryRuntime, choice: string): MemoryTier {
  if (choice === 'project' || choice === 'user') {
    if (!runtime.enabledTiers().includes(choice)) {
      throw new MemoryError(
        `the ${choice} memory tier is disabled in this deployment. Enabled tiers: ${runtime.enabledTiers().join(', ') || 'none'}.`,
        'MEMORY_TIER_DISABLED',
      )
    }
    return choice
  }
  if (choice !== 'auto') {
    throw new MemoryError(
      `unknown memory tier "${choice}". Use "project", "user", or "auto".`,
      'MEMORY_TIER_UNKNOWN',
    )
  }
  const first = runtime.enabledTiers()[0]
  if (first === undefined) {
    throw new MemoryError('no memory tier is available in this deployment.', 'MEMORY_NO_TIER')
  }
  return first
}

/** One entry as a single model-readable line. */
function formatEntry(entry: MemoryEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
  const origin = entry.origin === 'user' ? 'user' : 'consolidator'
  return `${entry.id}${tags} (${origin}): ${entry.text}`
}

/** Render a list of entries, or an honest empty state. */
function formatEntries(entries: readonly MemoryEntry[], empty: string): string {
  if (entries.length === 0) return empty
  return entries.map(formatEntry).join('\n')
}

const TIER_PARAMETER = {
  type: 'string' as const,
  enum: ['auto', 'project', 'user'],
  description: 'Which memory tier: project (this repository), user (standing personal facts), or auto (default: project when available).',
}

/**
 * The shared `output` block for a tool that returns one text value.
 *
 * `S` is threaded through so `render` receives the tool's inferred argument type
 * rather than a hand-written one — a mismatch there is exactly the kind of thing
 * that only shows up at runtime.
 */
function textOutput<S extends ParameterSchemaSpec>(transform?: (value: string, args: InferArgs<S>) => string) {
  return {
    schema: { type: 'string' as const },
    render: (args: InferArgs<S>, value: string) =>
      [{ type: 'text' as const, text: transform === undefined ? value : transform(value, args) }],
  }
}

/**
 * What the plugin resolved at load time, surfaced by `memory_status`.
 *
 * A tier can be off for reasons invisible from the outside — a disabled config
 * flag, an unresolvable home — and a disabled tier looks exactly like an empty one.
 * Reporting the source turns "why is my user memory not working" into a reading of
 * the tool's own output instead of a debugging session.
 */
export interface MemoryDiagnostics {
  /** Which candidate supplied the harness home. */
  readonly homeSource: string
  /** The resolved harness home, when one was found. */
  readonly home: string | undefined
  /** The project directory in effect when the plugin loaded. */
  readonly projectDir: string | undefined
}

/**
 * Build the memory tool definitions.
 *
 * Synchronous, and dependent on nothing outside this package: the definition
 * helper is implemented locally (see `./define.ts` for why). That is the whole
 * point — a tool surface that needs a module the profile cannot resolve is a
 * tool surface that is silently absent on a real install.
 *
 * @param runtime - the store owner.
 * @param diagnostics - what the plugin resolved at load time, for `memory_status`.
 * @returns registry-ready definitions in registration order.
 */
export function createMemoryTools(runtime: MemoryRuntime, diagnostics?: MemoryDiagnostics): ToolDefinition[] {
  return [
    defineTool({
      name: 'memory_add',
      description:
        'Store one durable fact about the user or the project: a preference, an identity detail, a convention, a decision, or a constraint worth not rediscovering. Keep it short and self-contained. Do not store transient task state, secrets, or anything the user asked you to forget.',
      parameters: {
        text: { type: 'string', required: true, description: 'One self-contained fact, at most a sentence or two.' },
        tier: TIER_PARAMETER,
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional short labels, e.g. ["style","build"].' },
      },
      output: textOutput(),
      async execute(args) {
        const tier = resolveTier(runtime, args.tier ?? 'auto')
        const store = runtime.store(tier)
        const result = store.add({
          text: args.text,
          tags: args.tags,
          origin: 'user',
          now: Date.now(),
        })
        if (!result.created) {
          return `Already remembered as ${result.entry.id} in ${tier} memory; nothing changed.`
        }
        runtime.commit(tier, store)
        return `Stored ${result.entry.id} in ${tier} memory (${store.size} entries used).`
      },
    }),

    defineTool({
      name: 'memory_update',
      description:
        'Replace an existing memory entry, or merge several related entries into one. Use this instead of adding a near-duplicate when a fact changed or a memory turned out to be wrong.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id from memory_list or memory_search.' },
        text: { type: 'string', description: 'The corrected text. Omit to change only the tags.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tags.' },
        tier: TIER_PARAMETER,
      },
      output: textOutput(),
      async execute(args) {
        const tier = resolveTier(runtime, args.tier ?? 'auto')
        const store = runtime.store(tier)
        const updated = store.update({
          id: args.id,
          text: args.text,
          tags: args.tags,
          origin: 'user',
          now: Date.now(),
        })
        runtime.commit(tier, store)
        return `Updated ${updated.id} in ${tier} memory: ${updated.text}`
      },
    }),

    defineTool({
      name: 'memory_delete',
      description: 'Forget one memory entry permanently. Use when the user asks you to forget something, or when an entry is obsolete or wrong and nothing replaces it.',
      parameters: {
        id: { type: 'string', required: true, description: 'Entry id from memory_list or memory_search.' },
        tier: TIER_PARAMETER,
      },
      output: textOutput(),
      async execute(args) {
        const tier = resolveTier(runtime, args.tier ?? 'auto')
        const store = runtime.store(tier)
        const removed = store.remove(args.id, Date.now())
        runtime.commit(tier, store)
        return `Forgot ${removed.id} from ${tier} memory.`
      },
    }),

    defineTool({
      name: 'memory_list',
      description: 'List stored memory entries with their ids. Use before updating or deleting, and when the user asks what you remember.',
      parameters: {
        tier: TIER_PARAMETER,
        query: { type: 'string', description: 'Optional literal substring filter.' },
      },
      output: textOutput(),
      async execute(args) {
        const tier = resolveTier(runtime, args.tier ?? 'auto')
        const entries = runtime.list(tier, args.query)
        return formatEntries(
          entries,
          `No memory entries matched in ${tier} memory.`,
        )
      },
    }),

    defineTool({
      name: 'memory_search',
      description: 'Search every enabled memory tier for a literal phrase and report which tier each hit lives in.',
      parameters: {
        query: { type: 'string', required: true, description: 'Literal text to look for, case-insensitive.' },
      },
      output: textOutput(),
      async execute(args) {
        const hits: string[] = []
        for (const tier of runtime.enabledTiers()) {
          const found = runtime.list(tier, args.query)
          if (found.length > 0) hits.push(`### ${tier}`, ...found.map(formatEntry), '')
        }
        return hits.length === 0
          ? `Nothing in memory matched "${args.query}".`
          : hits.join('\n').trimEnd()
      },
    }),

    defineTool({
      name: 'memory_status',
      description: 'Report where the memory files live, how full each tier is, whether the store is readable, and which tier is disabled. Re-reads from disk, so it reflects edits made outside this session. Use when memory seems wrong or empty.',
      parameters: {},
      output: textOutput(),
      async execute() {
        // Re-read from disk first. The runtime caches stores for the life of the
        // plugin (see `MemoryRuntime`), which is right for prompt assembly and
        // wrong here: this tool exists to explain a store that seems wrong, and
        // the interesting causes of that — a hand-edited file, a corrupted one, a
        // remembered fact the user removed themselves — are all invisible through
        // the cache. Without this, `readable` could only ever report the state
        // observed at the last write, which is the one state that is never in
        // doubt.
        runtime.refresh()
        const rows = runtime.describe()
        const lines = rows.length === 0
          ? ['No memory tier is enabled.']
          : rows.map(row => `${row.tier}: ${row.entries} entries, revision ${row.revision}, ${row.readable ? 'readable' : 'UNREADABLE'} at ${row.file}`)

        // Name the tiers that are OFF. An absent tier and an empty tier are
        // otherwise indistinguishable in this output, and which candidates were
        // tried for the harness home is the difference between "no memories yet"
        // and "this deployment has nowhere to put them".
        if (diagnostics !== undefined) {
          const enabled = new Set(runtime.enabledTiers())
          for (const tier of ['project', 'user'] as const) {
            if (enabled.has(tier)) continue
            lines.push(tier === 'project'
              ? 'project: DISABLED (no project directory was established for this session)'
              : `user: DISABLED (harness home not found; resolved from ${diagnostics.homeSource})`)
          }
          lines.push(`resolved: home=${diagnostics.home ?? '(none)'} via ${diagnostics.homeSource}`)
        }
        return lines.join('\n')
      },
    }),
  ]
}
