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
/** One lossless JSON value, as the tool pipeline carries it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
/** JSON Schema node types in the subset the harness enforces. */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
/**
 * One raw JSON Schema node.
 *
 * Mirrors the SDK's `JsonSchemaNode` *structurally* — same optional fields, same
 * names — so a definition built here stays assignable to the SDK's types even
 * though this package never imports them at runtime. The shape is not a
 * formality: `subagent.ts` hands a schema of this type to the harness, and the
 * conformance check in `typecheck.ts` is what proves it fits.
 */
export interface JsonSchemaNode {
    /** Omit with no constraints for any JSON value, or use `oneOf`. */
    type?: JsonSchemaType;
    /** Nested property schemas (`type: 'object'` only). */
    properties?: Record<string, JsonSchemaNode>;
    /** Required property names; each must appear in `properties`. */
    required?: string[];
    /** `false` rejects undeclared keys; absent follows JSON Schema's open default. */
    additionalProperties?: boolean;
    /** Item schema (`type: 'array'` only); absent accepts any item. */
    items?: JsonSchemaNode;
    /** Allowed values for a scalar node. */
    enum?: readonly (string | number | boolean | null)[];
    /** The single allowed value for a scalar node. */
    const?: string | number | boolean | null;
    description?: string;
    title?: string;
    default?: JsonValue;
    examples?: JsonValue;
}
/** A consumer-constrained object-rooted schema. */
export type ObjectJsonSchema = JsonSchemaNode & {
    type: 'object';
};
/** The compiled form of a tool's implicit parameter object. */
export type ParameterJsonSchema = JsonSchemaNode & {
    type: 'object';
    properties: Record<string, JsonSchemaNode>;
};
/** Annotation keywords shared by every author-facing schema node. */
export interface ValueSchemaAnnotations {
    description?: string;
    title?: string;
    default?: JsonValue;
    examples?: JsonValue;
}
/** String node: the only scalar with a literal constraint the memory tools use. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string';
    enum?: readonly string[];
    const?: string;
}
/** Number node, accepted for schema completeness. */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number';
    enum?: readonly number[];
    const?: number;
}
/** Integer node. */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'integer';
    enum?: readonly number[];
    const?: number;
}
/** Boolean node. */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean';
    enum?: readonly boolean[];
    const?: boolean;
}
/** Null node. */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'null';
    enum?: readonly null[];
    const?: null;
}
/**
 * Array node.
 *
 * Recompiled to `{ type, description?, items? }` with the same key order the SDK
 * emits, so a deep-equality check against the SDK passes rather than merely
 * comparing equal when stringified somewhere else.
 */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array';
    items?: ValueSchemaSpec;
}
/** Object node. Openness is mandatory, matching the SDK's rule. */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object';
    properties?: ParameterSchemaSpec;
    additionalProperties: boolean;
}
/** One branch of a `oneOf`. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]];
}
/** Author-facing schema for any JSON-value root. */
export type ValueSchemaSpec = StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec | ObjectValueSchemaSpec | OneOfValueSchemaSpec;
/** One parameter property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & {
    required?: true;
};
/**
 * Tool parameter schema: an implicit open object root whose properties carry
 * per-field `required: true`.
 */
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
/** Keys of a property map marked `required: true`. */
type RequiredKeys<S> = {
    [K in Extract<keyof S, string>]: S[K] extends {
        required: true;
    } ? K : never;
}[Extract<keyof S, string>];
/** The value type one author node describes. */
export type InferValue<S> = S extends {
    type: 'string';
} ? S extends {
    enum: readonly (infer E)[];
} ? Extract<E, string> : string : S extends {
    type: 'number' | 'integer';
} ? number : S extends {
    type: 'boolean';
} ? boolean : S extends {
    type: 'null';
} ? null : S extends {
    type: 'array';
    items?: infer I;
} ? I extends ValueSchemaSpec ? InferValue<I>[] : JsonValue[] : JsonValue;
/** A tool's validated argument object, derived from its parameter schema. */
export type InferArgs<S> = [RequiredKeys<S>] extends [never] ? {
    [K in Extract<keyof S, string>]?: InferValue<S[K]>;
} : {
    [K in Extract<keyof S, string>]?: InferValue<S[K]>;
} & {
    [K in RequiredKeys<S>]-?: InferValue<S[K]>;
};
/** One returned content block. Only text is produced here. */
export interface TextContentBlock {
    readonly type: 'text';
    readonly text: string;
}
/** The canonical output contract of a tool. */
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): TextContentBlock[];
}
/** A registry-ready tool definition. */
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: ParameterJsonSchema;
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: unknown): Promise<unknown>;
}
/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<O>): TextContentBlock[];
    };
    execute(args: InferArgs<S>, exec: unknown): Promise<InferValue<O>>;
}
/** An author-schema violation, reported before any tool runs. */
export declare class ToolSchemaError extends Error {
    readonly name = "ToolSchemaError";
    constructor(message: string);
}
/** Invalid model-generated arguments for a typed tool. */
export declare class ToolArgsError extends Error {
    readonly name = "ToolArgsError";
    readonly code = "INVALID_ARGS";
    readonly violations: readonly string[];
    constructor(violations: readonly string[]);
}
/**
 * Compile the implicit parameter object to raw JSON Schema.
 *
 * The root deliberately has no `additionalProperties`: the SDK's
 * `parameterSchemaSpecToJsonSchema` emits exactly `{type, properties, required?}`
 * and omits `required` entirely when nothing is required. An extra root key is
 * not harmless — it is a different schema sent to the model.
 */
export declare function compileParameters(spec: ParameterSchemaSpec, path?: string): ParameterJsonSchema;
/** Compile a tool's output schema. */
export declare function compileOutput(spec: ValueSchemaSpec): JsonSchemaNode;
/**
 * Assert a raw schema is object-rooted and structurally self-consistent.
 *
 * Used for the consolidator's `outputSchema`, which the harness requires to be
 * object-rooted.
 */
export declare function assertObjectJsonSchema(schema: unknown): void;
/**
 * Validate model-generated arguments against a parameter schema.
 *
 * Two entry points, matching the SDK's: author code holds the DSL spec, while a
 * compiled definition holds the raw schema.
 *
 * @returns Path-qualified violations; empty means valid.
 */
export declare function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[];
export declare function validateArgs(schema: ParameterJsonSchema, args: unknown): string[];
/**
 * Define a tool with strict argument validation.
 *
 * Mirrors the SDK's `defineTool` for the subset described in the module doc:
 * the body is not invoked unless the arguments validate, and an invalid call
 * throws {@link ToolArgsError} carrying every violation.
 */
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
export {};
//# sourceMappingURL=define.d.ts.map