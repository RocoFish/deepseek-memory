/**
 * Local message construction.
 *
 * Why not `createUserMessage` from `@deepseek-ai/dsh-llm`: the value import would
 * be a **bare specifier in the built output**, and a profile-installed plugin
 * cannot resolve `@deepseek-ai/*` — the loader imports the package by name from the
 * profile directory, whose `node_modules` holds only the profile's own
 * dependencies. A top-level bare import there does not degrade; it fails the whole
 * plugin with `failed to import`.
 *
 * The SDK's helper is small and its contract is explicit, so it is reproduced here
 * and checked against the SDK's own types in `typecheck.ts`. The import stays
 * type-only, which erases at compile time and leaves nothing to resolve.
 *
 * The rules being reproduced (`@deepseek-ai/dsh-llm`):
 * - `id` is a branded string; no format validation is performed.
 * - `role` is fixed to `'user'`.
 * - `content` is frozen.
 * - `source` is the producer's own, already declared on `MessageSourceMap`.
 *
 * @module deepseek-memory/message
 */
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
/**
 * Mint a message identity.
 *
 * `MessageId` is a branded string with no format validation, so any unique value
 * works; `crypto.randomUUID` is preferred when the host realm exposes it.
 */
export declare function nextMessageId(): string;
/** One content block holding plain text. */
export declare function textBlock(text: string): ContentBlock;
/**
 * Create one identified, frozen user-role message carrying this plugin's source.
 * @param text - the model-facing text.
 * @returns a complete `UserMessage`, ready for `Agent.inject` or a request's messages.
 */
export declare function createMemoryUserMessage(text: string): UserMessage;
//# sourceMappingURL=message.d.ts.map