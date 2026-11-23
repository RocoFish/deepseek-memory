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
import { join } from 'node:path'
import type { InferArgs, ParameterSchemaSpec, ToolDefinition } from './define.ts'
import { defineTool } from './define.ts'
import type { ArbitrationView, TieredEntry } from './arbitrate.ts'
import { buildArbitrationView, competingCards } from './arbitrate.ts'
import { assembleBundle, verifyExport, writeBundle } from './export.ts'
import type { RestoreSelection } from './restore.ts'
import { applyRestore, diffRestore } from './restore.ts'
import { findScopeViolations } from './scope.ts'
import { createSnapshot, listSnapshots, loadSnapshot, readCurrentStores, snapshotBaseDir } from './snapshot.ts'
import type { MemoryEntry, MemoryScope, MemoryTier } from './store.ts'
import { MemoryError, TIER_SCOPES } from './store.ts'
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
  const registration = entry.scope === 'project' ? '' : ` <${entry.scope}:${entry.subject}>`
  const status = entry.status === 'active' ? '' : ` (${entry.status})`
  return `${entry.id}${tags} (${origin})${registration}${status}: ${entry.text}`
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

/** Every card in every enabled tier, each with the tier that holds it. Unreadable tiers are skipped. */
function collectTiered(runtime: MemoryRuntime): TieredEntry[] {
  const tiered: TieredEntry[] = []
  for (const tier of runtime.enabledTiers()) {
    try {
      for (const entry of runtime.store(tier).entries()) tiered.push({ tier, entry })
    } catch { /* an unreadable tier is reported by memory_status, not by crashing the console */ }
  }
  return tiered
}

/** Find one card by id across every enabled tier. */
function findTiered(runtime: MemoryRuntime, id: string): TieredEntry {
  for (const tier of runtime.enabledTiers()) {
    const entry = runtime.store(tier).entries().find(candidate => candidate.id === id)
    if (entry !== undefined) return { tier, entry }
  }
  throw new MemoryError(
    `there is no memory entry with id ${id} in any enabled tier. Call memory_conflicts to see the current ids.`,
    'MEMORY_ENTRY_NOT_FOUND',
  )
}

/** One card, one line, with the household registration that matters for arbitration. */
function formatArbitrationCard(card: MemoryEntry, tier: MemoryTier, layer: string): string {
  const status = card.status === 'active' ? '' : ` status=${card.status}`
  return `  ${layer} [${card.id}] (${tier}, ${card.scope}:${card.subject}, ${card.confidence}, ${card.source}${status}): ${card.text}`
}

/** Render the arbitration console as plain text. */
function renderArbitrationView(view: ArbitrationView): string {
  const lines: string[] = [
    `cards: ${view.stats.total} total | active ${view.stats.active}, disputed ${view.stats.disputed}, `
    + `superseded ${view.stats.superseded}, archived ${view.stats.archived} | imported ${view.stats.imported} | tier violations ${view.stats.violations}`,
    '',
  ]
  if (view.groups.length === 0) lines.push('No competing groups.')
  for (const group of view.groups) {
    const decided = group.decidedBy === undefined ? '' : ` — decided by ${group.decidedBy}`
    lines.push(`[${group.subject} / ${group.key}]${decided}`)
    for (const card of group.cards) {
      lines.push(formatArbitrationCard(card.entry, card.tier, card.layer) + (card.disputed ? '  <-- DISPUTED, needs a ruling' : ''))
    }
    lines.push('')
  }
  if (view.flagged.length > 0) {
    lines.push('flagged:')
    for (const flagged of view.flagged) {
      lines.push(`  [${flagged.entry.id}] (${flagged.tier}, ${flagged.reason}): ${flagged.entry.text}`)
    }
  }
  return lines.join('\n').trimEnd()
}

/** One ISO timestamp line per snapshot, newest first. */
function renderSnapshotList(metas: { id: string; kind: string; trigger: string; createdAt: number }[]): string {
  if (metas.length === 0) return 'No snapshots yet.'
  return metas
    .map(meta => `${meta.id}  (${meta.kind}, ${meta.trigger}, ${new Date(meta.createdAt).toISOString()})`)
    .join('\n')
}

/** Parse one `tier:id:direction` restore selection token, with teaching errors. */
function parseRestoreToken(token: string): RestoreSelection {
  const parts = token.split(':')
  if (parts.length !== 3
    || (parts[0] !== 'project' && parts[0] !== 'user')
    || (parts[2] !== 'add' && parts[2] !== 'remove' && parts[2] !== 'modify')) {
    throw new MemoryError(
      `"${token}" is not a restore selection. Use the exact tokens from the preview: tier:id:direction, e.g. "project:m1a2b3c4:add".`,
      'MEMORY_RESTORE_BAD_SELECTION',
    )
  }
  return { tier: parts[0], id: parts[1]!, direction: parts[2] }
}

/** Snapshot before any arbitration mutation — step 3 of the roadmap exists because of this line. */
function snapshotBeforeArbitration(runtime: MemoryRuntime, action: string): string {
  const meta = createSnapshot(runtime, 'pre-op', `memory_arbitrate:${action}`)
  return meta.id
}

/** Commit every tier that received a mutation, in stable order. */
function commitTiers(runtime: MemoryRuntime, tiers: Iterable<MemoryTier>): void {
  for (const tier of new Set(tiers)) runtime.commit(tier, runtime.store(tier))
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
        subject: { type: 'string', description: 'What this memory is about, e.g. "deepseek-memory" or "math-modeling". Default: "preference" for user memory, "project" for project memory.' },
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
          ...(args.subject === undefined || args.subject.trim() === '' ? {} : { subject: args.subject.trim() }),
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
        // Surface scope violations without acting on them: a personal card in
        // the project store or a project card in the user store is flagged for
        // the user to arbitrate, never silently rewritten.
        for (const tier of runtime.enabledTiers()) {
          try {
            const violations = findScopeViolations(runtime.store(tier).entries(), tier)
            if (violations.length > 0) {
              lines.push(`scope violations in ${tier}: ${violations.map(entry => entry.id).join(', ')} (cards that do not belong in this tier)`)
            }
          } catch { /* readability was already reported above */ }
        }

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

    defineTool({
      name: 'memory_conflicts',
      description:
        'Read-only arbitration console: every (subject, key) group across all tiers, which value is in force and why, which cards lost, and which cards need your ruling (disputed groups, tier violations, unconfirmed imports, weak inferences). Suggests nothing and changes nothing.',
      parameters: {
        subjects: { type: 'array', items: { type: 'string' }, description: 'What this session is about, e.g. ["deepseek-memory"]. Gates which personal-topic cards enter the view.' },
      },
      output: textOutput(),
      async execute(args) {
        runtime.refresh()
        const tiered = collectTiered(runtime)
        const view = buildArbitrationView(tiered, {
          subjects: Array.isArray(args.subjects) ? args.subjects.filter(item => typeof item === 'string') : undefined,
        })
        return renderArbitrationView(view)
      },
    }),

    defineTool({
      name: 'memory_arbitrate',
      description:
        'Apply one human-confirmed ruling to the memory cards: adopt a value as the in-force one (competitors become superseded, never deleted), merge several cards into one new card, mark a card wrong (archived, kept for replay), or confirm an imported card into a real scope. A pre-operation snapshot is taken before anything is written.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['adopt', 'merge', 'mark-wrong', 'confirm-import'],
          description: 'adopt: ids[0] becomes the in-force value. merge: ids are merged into one new card (text required). mark-wrong: ids are archived. confirm-import: ids[0] (an imported card) enters the scope given by "scope".',
        },
        ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Card ids, from memory_conflicts.' },
        text: { type: 'string', description: 'For merge: the merged fact, one self-contained sentence.' },
        scope: {
          type: 'string',
          enum: ['project', 'personal-topic', 'personal-global'],
          description: 'For confirm-import: the scope the imported card enters.',
        },
      },
      output: textOutput(),
      async execute(args) {
        const ids = Array.isArray(args.ids) ? args.ids.filter(item => typeof item === 'string') : []
        if (ids.length === 0) {
          throw new MemoryError('memory_arbitrate needs at least one card id.', 'MEMORY_ENTRY_NOT_FOUND')
        }
        const snapshotId = snapshotBeforeArbitration(runtime, args.action)

        if (args.action === 'adopt') {
          const winner = findTiered(runtime, ids[0]!)
          const competitors = competingCards(winner.entry, collectTiered(runtime))
          const winnerStore = runtime.store(winner.tier)
          winnerStore.adjudicate({
            id: winner.entry.id,
            status: 'active',
            confidence: 'user-confirmed',
            supersedes: [...new Set([...winner.entry.supersedes, ...competitors.map(({ entry }) => entry.id)])],
            origin: 'user',
            now: Date.now(),
          })
          for (const { tier, entry } of competitors) {
            runtime.store(tier).adjudicate({ id: entry.id, status: 'superseded', origin: 'user', now: Date.now() })
          }
          commitTiers(runtime, [winner.tier, ...competitors.map(({ tier }) => tier)])
          return `Adopted ${winner.entry.id} as the in-force value. Demoted to superseded: ${competitors.map(({ entry }) => entry.id).join(', ') || 'none'}. Pre-operation snapshot: ${snapshotId}.`
        }

        if (args.action === 'merge') {
          if (typeof args.text !== 'string' || args.text.trim() === '') {
            throw new MemoryError('merge needs the merged fact as "text".', 'MEMORY_EMPTY_ENTRY')
          }
          const sources = ids.map(id => findTiered(runtime, id))
          const targetTier = sources[0]!.tier
          if (sources.some(({ tier }) => tier !== targetTier)) {
            throw new MemoryError(
              `cards ${sources.map(({ entry }) => entry.id).join(', ')} live in different tiers; merge sources from one tier at a time, then arbitrate across tiers.`,
              'MEMORY_MERGE_CROSS_TIER',
            )
          }
          const first = sources[0]!.entry
          const store = runtime.store(targetTier)
          const { entry: merged } = store.add({
            text: args.text,
            tags: [...new Set(sources.flatMap(({ entry }) => entry.tags))],
            origin: 'user',
            now: Date.now(),
            subject: first.subject,
            key: first.key,
            confidence: 'user-confirmed',
            source: 'user',
          })
          store.adjudicate({ id: merged.id, supersedes: sources.map(({ entry }) => entry.id), origin: 'user', now: Date.now() })
          for (const { entry } of sources) {
            store.adjudicate({ id: entry.id, status: 'superseded', origin: 'user', now: Date.now() })
          }
          runtime.commit(targetTier, store)
          return `Merged ${sources.length} cards into ${merged.id}. Superseded: ${sources.map(({ entry }) => entry.id).join(', ')}. Pre-operation snapshot: ${snapshotId}.`
        }

        if (args.action === 'mark-wrong') {
          const archived: string[] = []
          const tiers: MemoryTier[] = []
          for (const id of ids) {
            const { tier, entry } = findTiered(runtime, id)
            runtime.store(tier).adjudicate({ id: entry.id, status: 'archived', origin: 'user', now: Date.now() })
            archived.push(entry.id)
            tiers.push(tier)
          }
          commitTiers(runtime, tiers)
          return `Archived ${archived.join(', ')} (kept on disk for replay; deleting a card is a separate, explicitly confirmed step). Pre-operation snapshot: ${snapshotId}.`
        }

        // confirm-import
        const target = args.scope
        if (target !== 'project' && target !== 'personal-topic' && target !== 'personal-global') {
          throw new MemoryError('confirm-import needs "scope": project, personal-topic, or personal-global.', 'MEMORY_SCOPE_VIOLATION')
        }
        const { tier, entry } = findTiered(runtime, ids[0]!)
        if (entry.scope !== 'imported') {
          throw new MemoryError(`card ${entry.id} is not imported (scope ${entry.scope}); only imported cards need confirming.`, 'MEMORY_NOT_IMPORTED')
        }
        const targetTier: MemoryTier = target === 'project' ? 'project' : 'user'
        if (!TIER_SCOPES[targetTier].includes(target)) {
          throw new MemoryError(`scope "${target}" does not belong in the ${targetTier} tier.`, 'MEMORY_SCOPE_VIOLATION')
        }
        if (tier === targetTier) {
          runtime.store(tier).adjudicate({
            id: entry.id,
            scope: target,
            status: 'active',
            confidence: 'user-confirmed',
            origin: 'user',
            now: Date.now(),
          })
          runtime.commit(tier, runtime.store(tier))
        } else {
          runtime.store(tier).remove(entry.id, Date.now())
          runtime.commit(tier, runtime.store(tier))
          runtime.store(targetTier).upsertRestored({ ...entry, scope: target, status: 'active', confidence: 'user-confirmed', updatedAt: Date.now() })
          runtime.commit(targetTier, runtime.store(targetTier))
        }
        return `Confirmed ${entry.id} into scope ${target} (${targetTier} tier). Pre-operation snapshot: ${snapshotId}.`
      },
    }),

    defineTool({
      name: 'memory_snapshot',
      description: 'Create or list library snapshots. Snapshots capture both tiers whole and live outside the project directory; pruning keeps the newest pre-op x20, daily x7, weekly x4, pre-restore x10.',
      parameters: {
        action: { type: 'string', required: true, enum: ['create', 'list'], description: 'create: make a snapshot now. list: show every snapshot, newest first.' },
        kind: { type: 'string', enum: ['manual', 'daily', 'weekly'], description: 'For create: what kind of snapshot (default manual).' },
      },
      output: textOutput(),
      async execute(args) {
        if (args.action === 'list') return renderSnapshotList(listSnapshots(runtime))
        const kind = args.kind === 'daily' || args.kind === 'weekly' ? args.kind : 'manual'
        const meta = createSnapshot(runtime, kind, 'tool')
        return `Snapshot ${meta.id}\nkind: ${meta.kind}\nfile: ${meta.file}`
      },
    }),

    defineTool({
      name: 'memory_restore',
      description:
        'Restore from a snapshot, with a mandatory preview first. Preview shows four buckets per tier: added, removed, modified, conflicts. Apply takes only the explicitly confirmed selections (tier:id:direction tokens from the preview); the current library is backed up as a pre-restore snapshot before anything is written. Nothing is ever overwritten without being listed.',
      parameters: {
        snapshot: { type: 'string', required: true, description: 'Snapshot id, from memory_snapshot list.' },
        action: { type: 'string', required: true, enum: ['preview', 'apply'], description: 'preview: show the diff, change nothing. apply: restore only the listed selections.' },
        apply: { type: 'array', items: { type: 'string' }, description: 'For apply: the confirmed selections, e.g. ["project:m1a2b3c4:add","user:m5e6f7a8:modify"]. Conflicts apply only if explicitly listed.' },
      },
      output: textOutput(),
      async execute(args) {
        const snapshot = loadSnapshot(runtime, args.snapshot)
        if (args.action === 'preview') {
          const plan = diffRestore(snapshot, readCurrentStores(runtime))
          const lines: string[] = [
            `snapshot ${plan.snapshotId}, taken ${new Date(plan.snapshotCreatedAt).toISOString()}`,
            '',
          ]
          for (const tier of plan.tiers) {
            lines.push(`== ${tier.tier} ==`)
            for (const [label, entries] of [['added', tier.added], ['removed', tier.removed], ['modified', tier.modified]] as const) {
              lines.push(`${label} (${entries.length}):`)
              for (const entry of entries) lines.push(`  ${entry.id}: ${entry.text}`)
            }
            lines.push(`conflicts (${tier.conflicts.length}):`)
            for (const conflict of tier.conflicts) {
              lines.push(`  ${conflict.id}:`)
              lines.push(`    current:  ${conflict.current.text}`)
              lines.push(`    snapshot: ${conflict.snapshot.text}`)
            }
            lines.push(`unchanged: ${tier.unchanged}`, '')
          }
          lines.push('To apply, call memory_restore with action "apply" and the selections you confirm, e.g. apply=["project:m1a2b3c4:add"]. Conflicts apply only if explicitly listed.')
          return lines.join('\n')
        }
        const tokens = Array.isArray(args.apply) ? args.apply.filter(item => typeof item === 'string') : []
        const selections = tokens.map(parseRestoreToken)
        const result = applyRestore(runtime, snapshot, selections)
        const parts = result.touched.map(touched =>
          `${touched.tier}: ${touched.added} added, ${touched.removed} removed, ${touched.modified} modified`)
        return `Restore applied from ${snapshot.id}. Pre-restore backup: ${result.preRestoreId}. ${parts.join('; ')}.`
      },
    }),

    defineTool({
      name: 'memory_export',
      description:
        'Export memory to a directory: one Markdown file per card with YAML frontmatter plus INDEX.md (markdown), a JSONL stream (jsonl), or the full bundle zipped (zip). MANIFEST.json signs every file with SHA-256; credential-shaped strings are masked and counted. Export never touches the store.',
      parameters: {
        format: { type: 'string', required: true, enum: ['markdown', 'jsonl', 'zip', 'verify'], description: 'markdown: cards + INDEX.md. jsonl: one card per line. zip: the full bundle, zipped. verify: check an existing export against its MANIFEST.json.' },
        dest: { type: 'string', description: 'Target directory. Default: an export directory inside the user memory folder.' },
        include_project: { type: 'boolean', description: 'Include the project tier (default true).' },
        include_user: { type: 'boolean', description: 'Include the user tier — personal-global and personal-topic cards (default true).' },
        subjects: { type: 'array', items: { type: 'string' }, description: 'What this session is about; scopes the conflict counts in INDEX.md.' },
      },
      output: textOutput(),
      async execute(args) {
        if (args.format === 'verify') {
          if (typeof args.dest !== 'string' || args.dest.trim() === '') {
            throw new MemoryError('verify needs "dest": the export directory to check.', 'MEMORY_EXPORT_NO_DEST')
          }
          const result = verifyExport(args.dest)
          if (result.ok) return `Export at ${args.dest} verifies: every MANIFEST entry present, every SHA-256 matches.`
          return `Export at ${args.dest} FAILED verification.\nmissing: ${result.missing.join(', ') || 'none'}\nmismatched: ${result.mismatched.join(', ') || 'none'}`
        }

        runtime.refresh()
        const includeProject = args.include_project !== false
        const includeUser = args.include_user !== false
        if (!includeProject && !includeUser) {
          throw new MemoryError('an export must include at least one tier; both include_project and include_user are false.', 'MEMORY_EXPORT_EMPTY')
        }
        const tiered = collectTiered(runtime).filter(({ tier }) => (tier === 'project' ? includeProject : includeUser))
        if (tiered.length === 0) {
          throw new MemoryError('nothing to export: no memory entries in the included tiers.', 'MEMORY_EXPORT_EMPTY')
        }
        const entries = tiered.map(({ entry }) => entry)
        const scopes = [...new Set(entries.map(entry => entry.scope))] as MemoryScope[]
        const exclusions: { reason: string; count: number }[] = []
        if (!includeProject) exclusions.push({ reason: 'project tier excluded (include_project=false)', count: collectTiered(runtime).filter(({ tier }) => tier === 'project').length })
        if (!includeUser) exclusions.push({ reason: 'user tier excluded (include_user=false)', count: collectTiered(runtime).filter(({ tier }) => tier === 'user').length })
        const view = buildArbitrationView(tiered, {
          subjects: Array.isArray(args.subjects) ? args.subjects.filter(item => typeof item === 'string') : undefined,
        })
        const now = Date.now()
        const bundle = assembleBundle({
          createdAt: now,
          selection: {
            entries,
            exclusions,
            includesPersonalGlobal: includeUser,
          },
          view,
          scopes,
        })
        const base = typeof args.dest === 'string' && args.dest.trim() !== ''
          ? args.dest.trim()
          : join(snapshotBaseDir(runtime), 'exports', `export-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
        const written = writeBundle(base, bundle, args.format === 'zip', now)
        const redaction = bundle.redaction.length === 0
          ? 'no credential-shaped strings found'
          : bundle.redaction.map(item => `${item.label} x${item.count}`).join(', ')
        return `Exported ${entries.length} cards (${scopes.join(', ')}) to ${written.dir}`
          + (written.zipPath === undefined ? '' : `\nzip: ${written.zipPath}`)
          + `\nMANIFEST.json signs ${bundle.files.length} files; redaction: ${redaction}.`
          + '\nVerify later with memory_export format="verify" and the same dest.'
      },
    }),
  ]
}
