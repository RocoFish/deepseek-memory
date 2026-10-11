/**
 * After-turn memory consolidation.
 *
 * The turn boundary this hooks is `agent/status` → `idle`, which is an `emit`:
 * the turn has already closed and nothing waits for us. That is deliberate —
 * `agent/turn-stopping` is serial and awaited, so consolidating there would add
 * model latency to every single turn.
 *
 * The consolidator proposes a **change set**, it does not write. The plugin
 * validates and applies that set atomically, which buys three things a model with
 * direct write access cannot give:
 *
 * - a malformed or hallucinated action can only fail its own proposal, never
 *   leave a half-applied store;
 * - the ceilings are re-checked against the real store rather than trusted;
 * - the exact applied set is logged, so a surprising memory can be traced to the
 *   run that wrote it.
 *
 * @module deepseek-memory/consolidate
 */
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryConfig } from './config.ts'
import { describeDecision, evaluateGate, type GateDecision } from './gate.ts'
import { createMemoryUserMessage } from './message.ts'
import type { MemoryRuntime } from './runtime.ts'
import { MemoryError, type MemoryTier } from './store.ts'
import { runChildConsolidation, type SubagentConsolidator } from './subagent.ts'

/** Hard cap on proposals applied from one run, so one bad run cannot rewrite a whole store. */
export const MAX_ACTIONS_PER_RUN = 8

/** Hard cap on the transcript characters handed to the consolidator. */
export const MAX_TRANSCRIPT_CHARS = 6000

/** One proposed mutation from the consolidator. */
export type ProposedAction =
  | { readonly op: 'add'; readonly tier: MemoryTier; readonly text: string; readonly tags?: string[] }
  | { readonly op: 'update'; readonly tier: MemoryTier; readonly id: string; readonly text: string; readonly tags?: string[] }
  | { readonly op: 'delete'; readonly tier: MemoryTier; readonly id: string }
  | { readonly op: 'none' }

/** What one consolidation run did, for logs and for tests. */
export interface ConsolidationOutcome {
  readonly ran: boolean
  readonly reason: string
  readonly applied: readonly string[]
  readonly rejected: readonly string[]
}

/** The system prompt for the consolidator. Deliberately rigid about output shape. */
const CONSOLIDATOR_SYSTEM = `You maintain a small long-term memory store for an AI coding assistant.

You will receive the current memory entries and a transcript of the turn that just ended. Decide whether anything in that turn is worth remembering long-term, and reply with ONLY a JSON object.

Rules:
- Memory is for durable facts: who the user is, standing preferences, project conventions, decisions, constraints worth not rediscovering.
- Never store transient task state, file contents, code, command output, secrets, tokens, or anything the user asked you to forget.
- Prefer few, high-value entries. An empty change set is the correct answer most of the time.
- One fact per entry, at most a sentence or two. No bullet lists inside an entry.
- Use "update" when a fact changed or an existing entry is wrong; use "delete" when an entry is obsolete and nothing replaces it; use "add" only for genuinely new facts.
- "project" is for this repository's conventions; "user" is for facts about the person.

Reply with exactly this shape and nothing else:
{"actions":[{"op":"add","tier":"project","text":"...","tags":["..."]},{"op":"update","tier":"user","id":"m1a2b3c4","text":"..."},{"op":"delete","tier":"project","id":"m1a2b3c4"}]}

If nothing should change, reply {"actions":[]}.`

/** Render the current store state for the consolidator's prompt. */
function renderStore(runtime: MemoryRuntime): string {
  const parts: string[] = []
  for (const tier of runtime.enabledTiers()) {
    const entries = runtime.list(tier)
    parts.push(`### ${tier} (${entries.length} entries)`)
    if (entries.length === 0) parts.push('(empty)')
    else for (const entry of entries) parts.push(`${entry.id}: ${entry.text}`)
    parts.push('')
  }
  return parts.join('\n')
}

/**
 * Ask the model for a change set.
 *
 * `stream` is drained to a string rather than parsed incrementally: the proposal
 * is small, and a complete string is far easier to validate honestly than a
 * partially-applied stream of tool calls.
 */
async function requestProposal(
  llm: LlmRuntime,
  model: { provider: string; model: string },
  system: string,
  transcript: string,
  signal?: AbortSignal,
): Promise<string> {
  const options: GenerateOptions = {
    provider: model.provider,
    model: model.model,
    system,
    messages: [createMemoryUserMessage(transcript)],
    maxTokens: 1024,
    ...(signal === undefined ? {} : { signal }),
  }
  let text = ''
  for await (const chunk of llm.stream(options) as AsyncIterable<StreamChunk>) {
    const delta = (chunk as { delta?: { content?: unknown } }).delta?.content
    if (typeof delta === 'string') {
      text += delta
      continue
    }
    if (Array.isArray(delta)) {
      for (const block of delta) {
        if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const value = (block as { text?: unknown }).text
          if (typeof value === 'string') text += value
        }
      }
    }
  }
  return text
}

/**
 * Extract the JSON object from a model reply, tolerating a fenced block.
 * @returns the parsed value, or undefined when no object could be read.
 */
export function parseProposal(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  const candidate = (fenced?.[1] ?? reply).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Validate one raw action into a typed proposal, or explain why it was refused. */
export function validateAction(raw: unknown): { action: ProposedAction } | { refusal: string } {
  if (raw === null || typeof raw !== 'object') return { refusal: 'action is not an object' }
  const record = raw as Record<string, unknown>
  const op = record.op
  const tier = record.tier
  if (tier !== 'user' && tier !== 'project') return { refusal: `unknown tier ${JSON.stringify(tier)}` }

  if (op === 'add') {
    if (typeof record.text !== 'string' || record.text.trim() === '') return { refusal: 'add without text' }
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    return { action: { op: 'add', tier, text: record.text, ...(tags === undefined ? {} : { tags }) } }
  }
  if (op === 'update') {
    if (typeof record.id !== 'string' || record.id.trim() === '') return { refusal: 'update without id' }
    if (typeof record.text !== 'string' || record.text.trim() === '') return { refusal: 'update without text' }
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    return { action: { op: 'update', tier, id: record.id.trim(), text: record.text, ...(tags === undefined ? {} : { tags }) } }
  }
  if (op === 'delete') {
    if (typeof record.id !== 'string' || record.id.trim() === '') return { refusal: 'delete without id' }
    return { action: { op: 'delete', tier, id: record.id.trim() } }
  }
  return { refusal: `unknown op ${JSON.stringify(op)}` }
}

/**
 * Apply a validated change set to one tier.
 *
 * All-or-nothing per tier: a refusal rolls that tier's in-memory changes back by
 * reloading from disk, so a partially valid proposal cannot leave a store in a
 * state the model did not propose.
 * @returns the applied descriptions and the refusals.
 */
export function applyActions(
  runtime: MemoryRuntime,
  actions: readonly ProposedAction[],
  now: number,
): { applied: string[]; rejected: string[] } {
  const applied: string[] = []
  const rejected: string[] = []
  const touched = new Set<MemoryTier>()

  for (const action of actions) {
    const tier = action.op === 'none' ? undefined : action.tier
    if (tier === undefined) continue
    if (!runtime.enabledTiers().includes(tier)) {
      rejected.push(`${action.op}: tier ${tier} is disabled`)
      continue
    }
    try {
      const store = runtime.store(tier)
      if (action.op === 'add') {
        const result = store.add({ text: action.text, tags: action.tags, origin: 'consolidator', now })
        applied.push(result.created ? `add ${tier} ${result.entry.id}` : `add ${tier} ${result.entry.id} (already present)`)
      } else if (action.op === 'update') {
        const entry = store.update({ id: action.id, text: action.text, tags: action.tags, origin: 'consolidator', now })
        applied.push(`update ${tier} ${entry.id}`)
      } else if (action.op === 'delete') {
        const entry = store.remove(action.id, now)
        applied.push(`delete ${tier} ${entry.id}`)
      }
      touched.add(tier)
    } catch (error) {
      const detail = error instanceof MemoryError ? error.message : String(error)
      rejected.push(`${action.op} ${tier}: ${detail}`)
    }
  }

  for (const tier of touched) runtime.commit(tier)
  return { applied, rejected }
}

/** Gather the turn's text for the gate and the transcript, from session events. */
export interface TurnCapture {
  /** User-role messages that entered the turn, in order. */
  readonly userTexts: readonly string[]
  /** Assistant text produced during the turn, in order. */
  readonly assistantTexts: readonly string[]
}

/** Render a bounded transcript for the consolidator's single request. */
export function renderTranscript(capture: TurnCapture): string {
  const parts: string[] = ['## User', ...capture.userTexts, '', '## Assistant', ...capture.assistantTexts]
  const text = parts.join('\n').trim()
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(truncated)`
}

/** Everything the consolidator needs from the live runtime. */
export interface ConsolidatorDeps {
  readonly runtime: MemoryRuntime
  readonly config: MemoryConfig
  readonly llm: LlmRuntime | undefined
  readonly model: { provider: string; model: string } | undefined
  /** Model-facing messages, so the gate can inspect the turn. */
  readonly toUserMessages: (texts: readonly string[]) => Parameters<typeof evaluateGate>[0]['userMessages']
  readonly log: (message: string) => void
  readonly warn: (message: string) => void
  /**
   * The preferred consolidation path: a restricted child agent. Absent when the
   * deployment mounts no subagent provider, in which case the direct model request
   * is used instead.
   */
  readonly child?: {
    readonly subagents: SubagentConsolidator | undefined
    /** Registered subagent provider name. */
    readonly provider: string
    /** The spawning agent, required by the subagent seam. */
    readonly parent: Agent
    /** Wall-clock cap for one child run, so a stuck child cannot hold the slot. */
    readonly timeoutMs: number
  }
}

/**
 * Run one consolidation as a direct model request.
 *
 * This is the **fallback** path, used only when no subagent provider is available.
 * It asks for a JSON change set instead of letting a child call the memory tools,
 * because a bare `LlmRuntime` request has no tool loop: there is nowhere for a
 * tool call to execute. The trade-off is real and documented — the child path in
 * `subagent.ts` is strictly better when the deployment can offer it.
 *
 * @param deps - live services.
 * @param capture - the closed turn's text.
 * @param reason - the gate's explanation, carried into the outcome.
 * @param decision - the gate's signals.
 * @param signal - cancellation, when still live.
 */
async function consolidateDirect(
  deps: ConsolidatorDeps,
  capture: TurnCapture,
  reason: string,
  decision: GateDecision,
  signal?: AbortSignal,
): Promise<ConsolidationOutcome> {
  void decision
  const llm = deps.llm
  const model = deps.model
  if (llm === undefined || model === undefined) {
    return { ran: false, reason: 'no LLM route available', applied: [], rejected: [] }
  }
  try {
    const reply = await requestProposal(
      llm,
      model,
      `${CONSOLIDATOR_SYSTEM}\n\n## Current memory\n${renderStore(deps.runtime)}\n\n## Reply format reminder\nReply with the JSON object only.`,
      renderTranscript(capture),
      signal,
    )
    const parsed = parseProposal(reply)
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { actions?: unknown }).actions)) {
      deps.warn('consolidator reply was not a change set; ignored')
      return { ran: true, reason, applied: [], rejected: ['reply was not a valid change set'] }
    }
    const raw = (parsed as { actions: unknown[] }).actions.slice(0, MAX_ACTIONS_PER_RUN)
    const actions: ProposedAction[] = []
    const rejected: string[] = []
    for (const item of raw) {
      const validated = validateAction(item)
      if ('refusal' in validated) rejected.push(validated.refusal)
      else actions.push(validated.action)
    }
    if (rejected.length > 0) deps.warn(`consolidator proposed ${rejected.length} invalid action(s): ${rejected.join('; ')}`)

    const result = applyActions(deps.runtime, actions, Date.now())
    if (result.applied.length > 0) deps.log(`consolidated (${reason}): ${result.applied.join(', ')}`)
    return { ran: true, reason, applied: result.applied, rejected: [...rejected, ...result.rejected] }
  } catch (error) {
    // Memory maintenance is a convenience; it must never surface as a failed turn.
    deps.warn(`consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ran: false, reason: `error: ${error instanceof Error ? error.message : String(error)}`, applied: [], rejected: [] }
  }
}

/**
 * Run one consolidation, if the gate agrees.
 *
 * Prefers the restricted child agent, which needs no extra model configuration
 * (the child inherits the parent's route), gets its own context, and cannot reach
 * anything but the memory tools. Falls back to a direct model request when no
 * subagent provider is mounted, so a deployment without one still consolidates.
 *
 * @param deps - live services.
 * @param capture - the closed turn's text.
 * @param signal - cancellation from the turn that just closed, when still live.
 * @returns what happened, including the reason when nothing ran.
 */
export async function consolidateTurn(
  deps: ConsolidatorDeps,
  capture: TurnCapture,
  signal?: AbortSignal,
): Promise<ConsolidationOutcome> {
  if (deps.config.consolidation === 'off') {
    return { ran: false, reason: 'consolidation is off', applied: [], rejected: [] }
  }

  const decision: GateDecision = evaluateGate({
    userMessages: deps.toUserMessages(capture.userTexts),
    assistantText: capture.assistantTexts.join('\n'),
  })
  // The gate runs BEFORE either path so an uninteresting turn costs nothing at
  // all — no child, no model call.
  if (deps.config.consolidation === 'gated' && !decision.run) {
    return { ran: false, reason: 'gate: no durable signal', applied: [], rejected: [] }
  }

  const reason = describeDecision(decision)

  if (deps.child !== undefined && deps.child.subagents !== undefined) {
    return await consolidateChild(deps, capture, reason)
  }
  return await consolidateDirect(deps, capture, reason, decision, signal)
}

/**
 * Run one consolidation as a restricted child agent.
 *
 * The child is the one that writes memory, through this plugin's own tools, so
 * every ceiling and teaching error still applies. What the plugin adds is
 * verification: it compares store revisions across the run, so a child that
 * reports a change it did not make is caught rather than believed.
 */
async function consolidateChild(
  deps: ConsolidatorDeps,
  capture: TurnCapture,
  reason: string,
): Promise<ConsolidationOutcome> {
  const child = deps.child
  if (child === undefined || child.subagents === undefined) {
    return consolidateDirect(deps, capture, reason, { run: true, signals: [] })
  }

  // A closed turn's signal is often already aborted — reusing it would cancel the
  // child instantly. The run gets its own controller, released when it settles.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), child.timeoutMs)
  const revisionBefore = deps.runtime.enabledTiers()
    .reduce((sum, tier) => sum + deps.runtime.store(tier).revision, 0)
  const entriesBefore = deps.runtime.enabledTiers()
    .reduce((sum, tier) => sum + deps.runtime.store(tier).size, 0)

  try {
    const outcome = await runChildConsolidation(
      {
        subagents: child.subagents,
        provider: child.provider,
        runtime: deps.runtime,
        log: deps.log,
        warn: deps.warn,
      },
      { parent: child.parent, transcript: renderTranscript(capture), signal: controller.signal },
    )

    const applied = outcome.changed
      ? [`store moved: ${outcome.revisionBefore}→${outcome.revisionAfter} revision, ${entriesBefore}→${
        deps.runtime.enabledTiers().reduce((sum, tier) => sum + deps.runtime.store(tier).size, 0)} entries`]
      : []
    const rejected: string[] = []
    if (!outcome.completed) rejected.push(outcome.diagnostic ?? 'child did not complete')
    if (outcome.claimedChange && !outcome.changed) rejected.push('child reported a change the store does not show')

    if (applied.length > 0) {
      deps.log(`consolidated by child agent (${reason}): ${outcome.summary || 'no summary'}`)
    } else if (outcome.completed) {
      deps.log(`consolidator found nothing to keep (${reason})`)
    }
    void revisionBefore
    return { ran: true, reason, applied, rejected }
  } catch (error) {
    deps.warn(`child consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ran: false, reason: `child error: ${error instanceof Error ? error.message : String(error)}`, applied: [], rejected: [] }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
