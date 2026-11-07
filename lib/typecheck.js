export const _serviceRecognized = realSubagents;
export const _ctxHasSubagents = () => ctx.subagents;
export function _parentIsAgent(request) {
    // Round-tripping through the plugin's own parameter type proves the two agree.
    return request.parent;
}
export const _activationFitsRunHandle = activation;
export const _activationResultFitsReceipt = activationResult;
//# sourceMappingURL=typecheck.js.map