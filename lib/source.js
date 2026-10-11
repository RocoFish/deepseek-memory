/** This plugin's stable producer identity, used as the `kind` discriminant. */
export const MEMORY_SOURCE_KIND = 'deepseek-memory';
/** The source object every message this plugin injects carries. */
export function memorySource() {
    return { kind: MEMORY_SOURCE_KIND };
}
//# sourceMappingURL=source.js.map