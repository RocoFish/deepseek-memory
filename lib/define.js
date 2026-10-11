/**
 * The tool-definition helper, implemented locally.
 *
 * ## Why this is not imported from `@deepseek-ai/dsh-tools`
 *
 * A community plugin is installed *into a profile*, and a profile's
 * `node_modules` contains only what that profile declares. The Harness SDK is
 * not there. Measured consequence: a top-level value import of any
 * `@deepseek-ai/*` specifier fails the entire plugin load — not one feature, the
 * whole entry point — before a single hook registers.
 *
 * Reaching the helper by dynamic `import()` does not fix it either. It moves the
 * failure from "plugin will not load" to "tool surface silently missing", and on
 * this machine it fails for a second reason: pnpm links packages with junctions,
 * so `dsh-tools` is entered at
 * `node_modules\@deepseek-ai\dsh-tools\lib\index.js` rather than at its real
 * store path, and its own `import '@deepseek-ai/schemastery'` does not resolve
 * from there — even though schemastery *is* installed as a sibling link in the
 * pnpm store. `ERR_MODULE_NOT_FOUND: Cannot find package
 * '@deepseek-ai/schemastery' imported from ...\node_modules\@deepseek-ai\dsh-tools\lib\index.js`.
 *
 * So this module implements the part of the SDK's contract the memory tools
 * actually need: compile the author-facing parameter DSL to raw JSON Schema,
 * validate model arguments against it, and wrap a body into a registry-ready
 * definition. Three functions, no dependencies.
 *
 * ## The risk this creates, and how it is held down
 *
 * A hand-written stand-in for harness behaviour can drift from the harness. Two
 * things keep it honest:
 *
 * 1. {@link ../tests/define.test.ts} compiles the same options through the real
 *    SDK `defineTool` and asserts deep equality of the output, and asserts the
 *    error shape matches too. If the SDK changes, that test fails.
 * 2. {@link ../src/typecheck.ts} asserts the returned definition is still
 *    assignable to the SDK's `ToolDefinition`, so a field the registry needs
 *    cannot be dropped silently.
 *
 * ## Deliberately limited
 *
 * Only the subset the memory tools use is implemented: an object root whose
 * properties are scalars, string enums, or arrays of strings, plus a string
 * output. Anything else is rejected loudly by {@link compileParameters} rather
 * than compiled approximately, because a silently wrong schema reaches the model
 * as a wrong tool contract.
 *
 * @module deepseek-memory/define
 */
/** An author-schema violation, reported before any tool runs. */
export class ToolSchemaError extends Error {
    name = 'ToolSchemaError';
    constructor(message) {
        super(message);
    }
}
/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends Error {
    name = 'ToolArgsError';
    code = 'INVALID_ARGS';
    violations;
    constructor(violations) {
        super(`invalid arguments: ${violations.join('; ')}`);
        this.violations = violations;
    }
}
/* ------------------------------------------------------------- compilation */
/** Annotation keys copied through to the compiled node, in SDK order. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
/** Reject author keys outside one node's declared vocabulary. */
function assertKeys(spec, path, allowed) {
    for (const key of Object.keys(spec)) {
        if (!allowed.includes(key)) {
            throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`);
        }
    }
}
/**
 * Copy annotations onto a node.
 *
 * Order matters: the SDK assigns `type` first and annotations second, which is
 * why a compiled leaf reads `{type, description, enum}` and not
 * `{type, enum, description}`. Matching that order keeps deep equality with the
 * SDK's own output, not just JSON equivalence.
 */
function copyAnnotations(spec, node) {
    for (const key of ANNOTATION_KEYS) {
        if (Object.hasOwn(spec, key))
            node[key] = spec[key];
    }
}
/** Compile one leaf/array/object node. */
function compileValue(spec, path) {
    if (spec === null || typeof spec !== 'object') {
        throw new ToolSchemaError(`${path} must be a value schema object`);
    }
    const source = spec;
    const node = {};
    const type = source['type'];
    switch (type) {
        case 'string':
        case 'number':
        case 'integer':
        case 'boolean':
        case 'null': {
            assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'enum', 'const']);
            node['type'] = type;
            copyAnnotations(source, node);
            if (Object.hasOwn(source, 'enum')) {
                const list = source['enum'];
                if (!Array.isArray(list))
                    throw new ToolSchemaError(`${path}.enum must be an array of scalar values`);
                node['enum'] = list.map(entry => entry);
            }
            if (Object.hasOwn(source, 'const'))
                node['const'] = source['const'];
            return node;
        }
        case 'array': {
            assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'items']);
            node['type'] = 'array';
            copyAnnotations(source, node);
            if (Object.hasOwn(source, 'items')) {
                node['items'] = compileValue(source['items'], `${path}.items`);
            }
            return node;
        }
        case 'object': {
            assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'properties', 'additionalProperties']);
            if (typeof source['additionalProperties'] !== 'boolean') {
                throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`);
            }
            node['type'] = 'object';
            copyAnnotations(source, node);
            node['additionalProperties'] = source['additionalProperties'];
            if (Object.hasOwn(source, 'properties')) {
                const compiled = compileParameters(source['properties'], `${path}.properties`);
                node['properties'] = compiled.properties;
                if (compiled.required !== undefined)
                    node['required'] = compiled.required;
            }
            return node;
        }
        default:
            throw new ToolSchemaError(`${path}.type must be string/number/integer/boolean/null/array/object, or use oneOf`);
    }
}
/**
 * Compile the implicit parameter object to raw JSON Schema.
 *
 * The root deliberately has no `additionalProperties`: the SDK's
 * `parameterSchemaSpecToJsonSchema` emits exactly `{type, properties, required?}`
 * and omits `required` entirely when nothing is required. An extra root key is
 * not harmless — it is a different schema sent to the model.
 */
export function compileParameters(spec, path = 'parameters') {
    if (spec === null || typeof spec !== 'object') {
        throw new ToolSchemaError(`${path} must be an object`);
    }
    const properties = {};
    const required = [];
    for (const key of Object.keys(spec)) {
        const property = spec[key];
        if (property === undefined || property === null || typeof property !== 'object') {
            throw new ToolSchemaError(`${path}.${key} must be a value schema object`);
        }
        const record = property;
        if (Object.hasOwn(record, 'required') && record['required'] !== true) {
            throw new ToolSchemaError(`${path}.${key}.required must be true when present`);
        }
        if (record['required'] === true)
            required.push(key);
        // The `required` marker is author-only; it must not leak into the schema.
        const { required: _required, ...valueSpec } = record;
        properties[key] = compileValue(valueSpec, `${path}.${key}`);
    }
    return required.length === 0
        ? { type: 'object', properties }
        : { type: 'object', properties, required };
}
/** Compile a tool's output schema. */
export function compileOutput(spec) {
    return compileValue(spec, 'schema');
}
/* ------------------------------------------------------- raw schema checks */
/** Node types this build recognises in a raw schema. */
const RAW_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
/**
 * Check one raw schema node and its descendants for structural self-consistency.
 *
 * Deliberately *not* a reimplementation of the harness's schema checker, and not
 * claimed to be one: it answers "is this literal schema internally coherent and
 * inside the subset I would accept?", which is what a schema this package owns
 * needs. Anything it cannot judge it rejects rather than waves through.
 */
function checkRawSchema(schema, path, violations) {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        violations.push(`${path} must be a schema object`);
        return;
    }
    const node = schema;
    const declared = node['type'];
    if (declared === undefined) {
        // An annotation-only node is the unconstrained-JSON form.
        if (Object.keys(node).length === 0)
            return;
        violations.push(`${path}.type is missing`);
        return;
    }
    if (typeof declared !== 'string' || !RAW_TYPES.includes(declared)) {
        violations.push(`${path}.type must be one of ${RAW_TYPES.join('/')}`);
        return;
    }
    if (declared === 'object') {
        if (typeof node['additionalProperties'] !== 'boolean') {
            violations.push(`${path}.additionalProperties must be explicitly true or false`);
        }
        const properties = node['properties'];
        if (properties !== undefined) {
            if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
                violations.push(`${path}.properties must be an object`);
            }
            else {
                for (const [key, child] of Object.entries(properties)) {
                    checkRawSchema(child, `${path}.properties.${key}`, violations);
                }
            }
        }
        const required = node['required'];
        if (required !== undefined) {
            if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
                violations.push(`${path}.required must be an array of strings`);
            }
            else if (properties !== undefined && properties !== null && typeof properties === 'object') {
                const declaredKeys = new Set(Object.keys(properties));
                for (const key of required) {
                    if (!declaredKeys.has(key))
                        violations.push(`${path}.required names "${key}" which is not in properties`);
                }
            }
        }
        return;
    }
    if (declared === 'array') {
        if (Object.hasOwn(node, 'items'))
            checkRawSchema(node['items'], `${path}.items`, violations);
        return;
    }
    const allowed = node['enum'];
    if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length === 0)) {
        violations.push(`${path}.enum must be a non-empty array`);
    }
}
/**
 * Assert a raw schema is object-rooted and structurally self-consistent.
 *
 * Used for the consolidator's `outputSchema`, which the harness requires to be
 * object-rooted.
 */
export function assertObjectJsonSchema(schema) {
    const violations = [];
    checkRawSchema(schema, 'schema', violations);
    if (violations.length === 0) {
        const node = schema;
        if (node === null || typeof node !== 'object' || node['type'] !== 'object') {
            violations.push('schema.type must be "object" (structured output is object-rooted)');
        }
    }
    if (violations.length > 0)
        throw new ToolSchemaError(violations.join('; '));
}
/* -------------------------------------------------------------- validation */
/** Whether a value is a lossless JSON value. */
function isJsonValue(value) {
    if (value === null)
        return true;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean')
        return true;
    if (kind === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (kind === 'object') {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        return Object.values(value).every(isJsonValue);
    }
    return false;
}
/** The path prefix the validator reports at the argument root. */
function diagnosticPath(path) {
    return path === '' ? 'arguments' : path;
}
/** Append one object-property path segment without a leading dot at the root. */
function propertyPath(path, key) {
    return path === '' ? key : `${path}.${key}`;
}
function scalarMatches(schema, value) {
    switch (schema['type']) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            return false;
    }
}
/**
 * Validate one value against a compiled schema node.
 *
 * The messages mirror the SDK's shape (`"<path>" must be a <type>`) so a model
 * that learned to read one sees the same guidance from the other.
 */
function checkValue(schema, value, path, violations) {
    if (schema === null || typeof schema !== 'object') {
        violations.push(`"${diagnosticPath(path)}" has an unsupported schema`);
        return;
    }
    const node = schema;
    if (Array.isArray(node['oneOf'])) {
        // Not used by the memory tools, but a silent pass would be worse than a
        // refusal: an unsupported node must not validate anything by accident.
        violations.push(`"${diagnosticPath(path)}" uses oneOf, which this build does not validate`);
        return;
    }
    const declared = node['type'];
    if (declared === undefined) {
        if (!isJsonValue(value))
            violations.push(`"${diagnosticPath(path)}" must be a lossless JSON value`);
        return;
    }
    if (declared === 'object') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            violations.push(`"${diagnosticPath(path)}" must be an object`);
            return;
        }
        if (!isJsonValue(value)) {
            violations.push(`"${diagnosticPath(path)}" must be a lossless JSON value`);
            return;
        }
        const record = value;
        const properties = (node['properties'] ?? {});
        const required = Array.isArray(node['required']) ? node['required'] : [];
        for (const key of Object.keys(record)) {
            const child = properties[key];
            if (child === undefined) {
                if (node['additionalProperties'] === false) {
                    violations.push(`"${propertyPath(path, key)}" is not a declared property`);
                }
                continue;
            }
            checkValue(child, record[key], propertyPath(path, key), violations);
        }
        for (const key of required) {
            if (!Object.hasOwn(record, key)) {
                violations.push(`"${propertyPath(path, key)}" is required`);
            }
        }
        return;
    }
    if (declared === 'array') {
        if (!Array.isArray(value)) {
            violations.push(`"${diagnosticPath(path)}" must be an array`);
            return;
        }
        const items = node['items'];
        if (items === undefined)
            return;
        value.forEach((entry, index) => {
            checkValue(items, entry, `${path}[${index}]`, violations);
        });
        return;
    }
    if (!scalarMatches(node, value)) {
        violations.push(`"${diagnosticPath(path)}" must be a ${String(declared)}`);
        return;
    }
    const allowed = node['enum'];
    if (Array.isArray(allowed) && !allowed.includes(value)) {
        violations.push(`"${diagnosticPath(path)}" must be one of ${allowed.map(entry => JSON.stringify(entry)).join(', ')}`);
        return;
    }
    if (Object.hasOwn(node, 'const') && node['const'] !== value) {
        violations.push(`"${diagnosticPath(path)}" must be ${JSON.stringify(node['const'])}`);
    }
}
export function validateArgs(specOrSchema, args) {
    const looksCompiled = specOrSchema.type === 'object'
        && Object.hasOwn(specOrSchema, 'properties');
    const schema = looksCompiled
        ? specOrSchema
        : compileParameters(specOrSchema);
    if (args === undefined || args === null) {
        // A call with no arguments is the common case for a tool that declares none,
        // and for one that declares only optional fields. A missing required field is
        // reported the same way the object walk reports it.
        const required = Array.isArray(schema.required) ? schema.required : [];
        const violations = required.map(key => `"${key}" is required`);
        if (violations.length > 0)
            return violations;
        return args === null ? ['"arguments" must be an object'] : [];
    }
    const violations = [];
    checkValue(schema, args, '', violations);
    return violations;
}
/* ------------------------------------------------------------------ helper */
/**
 * Define a tool with strict argument validation.
 *
 * Mirrors the SDK's `defineTool` for the subset described in the module doc:
 * the body is not invoked unless the arguments validate, and an invalid call
 * throws {@link ToolArgsError} carrying every violation.
 */
export function defineTool(options) {
    const parameters = compileParameters(options.parameters);
    const outputSchema = compileOutput(options.output.schema);
    const userRender = options.output.render;
    return {
        name: options.name,
        description: options.description,
        parameters,
        output: {
            schema: outputSchema,
            render(args, value) {
                return userRender(args, value);
            },
        },
        async execute(args, exec) {
            const violations = validateArgs(parameters, args);
            if (violations.length > 0)
                throw new ToolArgsError(violations);
            return await options.execute(args, exec);
        },
    };
}
//# sourceMappingURL=define.js.map