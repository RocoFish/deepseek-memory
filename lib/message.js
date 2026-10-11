import { memorySource } from "./source.js";
let counter = 0;
/**
 * Mint a message identity.
 *
 * `MessageId` is a branded string with no format validation, so any unique value
 * works; `crypto.randomUUID` is preferred when the host realm exposes it.
 */
export function nextMessageId() {
    const crypto = globalThis.crypto;
    if (crypto !== undefined && typeof crypto.randomUUID === 'function')
        return crypto.randomUUID();
    counter += 1;
    return `memory-${Date.now().toString(36)}-${counter}`;
}
/** One content block holding plain text. */
export function textBlock(text) {
    return { type: 'text', text };
}
/**
 * Create one identified, frozen user-role message carrying this plugin's source.
 * @param text - the model-facing text.
 * @returns a complete `UserMessage`, ready for `Agent.inject` or a request's messages.
 */
export function createMemoryUserMessage(text) {
    const content = [textBlock(text)];
    return Object.freeze({
        id: nextMessageId(),
        role: 'user',
        content: Object.freeze(content),
        source: memorySource(),
    });
}
//# sourceMappingURL=message.js.map