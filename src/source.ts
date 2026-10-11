/**
 * This plugin's own message-source kind.
 *
 * The harness has **no shared catch-all `plugin` source kind**. `MessageSourceMap`
 * is a merge-extensible sum type and the documented pattern is that each producer
 * declares its own `kind` in its own module:
 *
 * > Merge-extensible sum type — each producer declares its own `kind` in its own
 * > module; there is no shared catch-all `plugin` kind.
 * > — `@deepseek-ai/dsh-llm/lib/types/message.d.ts`
 *
 * So a plugin that injects a user-role message must augment this map. Writing
 * `{ kind: 'plugin', plugin: 'x' }` — the shape older releases accepted, and a
 * shape still found all over the harness's own test fixtures — does not typecheck
 * against 0.2 and produces `format v4 message requires a producer-owned source
 * kind` at the log boundary on the versions that enforce it at runtime.
 *
 * Keeping the augmentation in its own module is deliberate: it is the one place a
 * reader needs to look to see how this plugin identifies itself in the log, and it
 * must be imported before any source object is constructed.
 *
 * @module deepseek-memory/source
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** This plugin's stable producer identity, used as the `kind` discriminant. */
export const MEMORY_SOURCE_KIND = 'deepseek-memory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * A user-role message injected by the memory plugin.
     *
     * `form` is left undeclared: memory context is presented as opaque content,
     * which is the documented default, and declaring a form would promise a
     * structured rendering this plugin does not produce.
     */
    'deepseek-memory': {
      kind: 'deepseek-memory'
    }
  }
}

/** The source object every message this plugin injects carries. */
export function memorySource(): UserMessage['source'] {
  return { kind: MEMORY_SOURCE_KIND }
}
