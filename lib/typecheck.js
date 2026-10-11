export const _serviceSatisfiesPlugin = realSubagents;
// And the plugin must never rely on more of it than the interface promises.
export const _pluginUsesSubset = true;
export const _ctxHasSubagents = () => ctx.subagents;
export function _parentIsAgent(request) {
    // Round-tripping through the plugin's own parameter type proves the two agree.
    return request.parent;
}
export const _runSatisfiesPlugin = run;
//# sourceMappingURL=typecheck.js.map