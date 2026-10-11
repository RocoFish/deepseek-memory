/**
 * The cheap gate that decides whether a closed turn is worth consolidating.
 *
 * The expensive part of memory maintenance is the model call that reads a turn
 * and rewrites the store. Paying it after every turn is faithful but wasteful:
 * most turns contain nothing durable. This gate is a local, allocation-light,
 * fully deterministic scan for the handful of situations that actually change
 * long-term memory, so the model call happens only when it can pay for itself.
 *
 * Being a heuristic, it is deliberately biased toward **under**-triggering: a
 * missed consolidation is repaired by the next related turn, whereas an eager
 * consolidator that runs on chatter eventually starts inventing memories.
 *
 * @module deepseek-memory/gate
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** One recognized reason a turn may deserve consolidation. */
export interface GateSignal {
  /** Stable discriminant, also used in logs. */
  readonly kind: string
  /** The matched phrase, for explaining the decision. */
  readonly evidence: string
  /** Relative importance; the highest matching signal decides. */
  readonly weight: number
}

/** The gate's verdict for one closed turn. */
export interface GateDecision {
  /** Whether the consolidator should run. */
  readonly run: boolean
  /** Why, best signal first. */
  readonly signals: readonly GateSignal[]
}

/** Messages the gate inspects. Assistant text counts, tool output does not. */
export interface GateInput {
  /** Every user-role message that entered the turn, in order. */
  readonly userMessages: readonly UserMessage[]
  /** The assistant's own final text for the turn, when available. */
  readonly assistantText?: string
}

interface Pattern {
  readonly kind: string
  readonly weight: number
  readonly re: RegExp
}

/**
 * Signals that a turn changed durable knowledge.
 *
 * Ordered by weight: an explicit request to remember always wins, then a
 * correction (which must override existing memory), then a standing preference,
 * then a decision, then a constraint or gotcha. Weights are small integers so a
 * single user signal always outranks any amount of assistant prose.
 */
const PATTERNS: readonly Pattern[] = [
  // Explicit instruction to remember — the strongest possible signal.
  { kind: 'explicit-remember', weight: 100, re: /记住|记下来|记一下|别忘了|帮我记|请记|remember\s+(that|this|my)|make a note|note\s+that|don'?t forget|keep in mind/i },
  // The user is correcting the agent or overriding an earlier belief.
  { kind: 'correction', weight: 80, re: /不对|不是这样|错了|纠正|更正|应该是|其实是|我说的是|改成|换成|以后不要|以后别|不要再|别再|下次别|你搞错|误解/i },
  { kind: 'correction', weight: 80, re: /\b(actually|correction|i said|not that|that'?s wrong|you misunderstood|instead of|from now on (?:don'?t|do not|use|stop))\b/i },
  // Durable preference or working style.
  { kind: 'preference', weight: 60, re: /我(更)?(喜欢|偏好|倾向于|习惯|不喜欢|讨厌|想要)|我希望|我需要|请(尽量|总是|始终|一律|统一)|我们(统一|约定)|尽量(不要|别)/i },
  { kind: 'preference', weight: 60, re: /\bi (?:prefer|like|dislike|hate|always|never|usually|want)\b|\balways use\b|\bnever use\b|\bplease always\b/i },
  // A durable decision or convention.
  { kind: 'decision', weight: 50, re: /决定|就这么定|约定|规范|规矩|标准是|采用|统一用|默认用|以后都/i },
  { kind: 'decision', weight: 50, re: /\bwe (?:decided|agreed|settled on)\b|\bthe convention is\b|\bthe rule is\b|\bfrom now on\b|\bgoing forward\b/i },
  // A constraint, gotcha, or hard-won finding worth not rediscovering.
  { kind: 'constraint', weight: 40, re: /不能|不可以|不允许|必须|一定要|禁止|注意|坑|限制|只能|务必/i },
  { kind: 'constraint', weight: 40, re: /\bmust not\b|\bcannot be\b|\brequired to\b|\bis mandatory\b|\bgotcha\b|\bthe catch is\b|\bonly works if\b/i },
]

/** Lower-case a string without allocating a new array of code points. */
function textOf(message: UserMessage): string {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .map(block => (block !== null && typeof block === 'object' && block.type === 'text' ? block.text : ''))
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('\n')
}

/**
 * Evaluate one closed turn.
 *
 * @param input - the turn's user messages and optional assistant text.
 * @returns whether to consolidate, and the signals that decided it.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const found = new Map<string, GateSignal>()

  const record = (kind: string, weight: number, evidence: string): void => {
    const existing = found.get(kind)
    if (existing === undefined || weight > existing.weight) found.set(kind, { kind, weight, evidence })
  }

  // User text carries full weight; the assistant's own prose is discounted,
  // because a model describing its reasoning is not the user asking it to remember.
  for (const message of input.userMessages) {
    const text = textOf(message)
    if (text === '') continue
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(text)
      if (match === null) continue
      record(pattern.kind, pattern.weight, match[0])
    }
  }

  const assistantText = input.assistantText ?? ''
  if (assistantText !== '') {
    for (const pattern of PATTERNS) {
      // Only the two strongest categories count from the assistant: it may
      // narrate a decision it just took, but it must not create preferences.
      if (pattern.kind !== 'decision' && pattern.kind !== 'constraint') continue
      const match = pattern.re.exec(assistantText)
      if (match === null) continue
      record(pattern.kind, Math.floor(pattern.weight / 4), match[0])
    }
  }

  const signals = [...found.values()].sort((left, right) => right.weight - left.weight)
  return { run: signals.length > 0, signals }
}

/** One-line explanation for logs, so a skipped or taken run is auditable. */
export function describeDecision(decision: GateDecision): string {
  if (!decision.run) return 'no durable signal'
  return decision.signals.map(signal => `${signal.kind}:"${signal.evidence}"`).join(', ')
}
