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

/* ------------------------------------------------------------ JSON values */

/** One lossless JSON value, as the tool pipeline carries it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** JSON Schema node types in the subset the harness enforces. */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

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
  type?: JsonSchemaType
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: readonly (string | number | boolean | null)[]
  /** The single allowed value for a scalar node. */
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue
}

/** A consumer-constrained object-rooted schema. */
export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

/** The compiled form of a tool's implicit parameter object. */
export type ParameterJsonSchema = JsonSchemaNode & {
  type: 'object'
  properties: Record<string, JsonSchemaNode>
}

/* -------------------------------------------------------------- author DSL */

/** Annotation keywords shared by every author-facing schema node. */
export interface ValueSchemaAnnotations {
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue
}

/** String node: the only scalar with a literal constraint the memory tools use. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

/** Number node, accepted for schema completeness. */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

/** Integer node. */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

/** Boolean node. */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

/** Null node. */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

/**
 * Array node.
 *
 * Recompiled to `{ type, description?, items? }` with the same key order the SDK
 * emits, so a deep-equality check against the SDK passes rather than merely
 * comparing equal when stringified somewhere else.
 */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/** Object node. Openness is mandatory, matching the SDK's rule. */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

/** One branch of a `oneOf`. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

/** Author-facing schema for any JSON-value root. */
export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | OneOfValueSchemaSpec

/** One parameter property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * Tool parameter schema: an implicit open object root whose properties carry
 * per-field `required: true`.
 */
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}

/** Keys of a property map marked `required: true`. */
type RequiredKeys<S> = {
  [K in Extract<keyof S, string>]: S[K] extends { required: true } ? K : never
}[Extract<keyof S, string>]

/** The value type one author node describes. */
export type InferValue<S> =
  S extends { type: 'string' }
    ? S extends { enum: readonly (infer E)[] }
      ? Extract<E, string>
      : string
    : S extends { type: 'number' | 'integer' }
      ? number
      : S extends { type: 'boolean' }
        ? boolean
        : S extends { type: 'null' }
          ? null
          : S extends { type: 'array'; items?: infer I }
            ? I extends ValueSchemaSpec ? InferValue<I>[] : JsonValue[]
            : JsonValue

/** A tool's validated argument object, derived from its parameter schema. */
export type InferArgs<S> = [RequiredKeys<S>] extends [never]
  ? { [K in Extract<keyof S, string>]?: InferValue<S[K]> }
  : { [K in Extract<keyof S, string>]?: InferValue<S[K]> } & {
    [K in RequiredKeys<S>]-?: InferValue<S[K]>
  }

/* ---------------------------------------------------------- tool contract */

/** One returned content block. Only text is produced here. */
export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** The canonical output contract of a tool. */
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): TextContentBlock[]
}

/** A registry-ready tool definition. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: ParameterJsonSchema
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly output: {
    readonly schema: O
    render(args: InferArgs<S>, value: InferValue<O>): TextContentBlock[]
  }
  execute(args: InferArgs<S>, exec: unknown): Promise<InferValue<O>>
}

/** An author-schema violation, reported before any tool runs. */
export class ToolSchemaError extends Error {
  override readonly name = 'ToolSchemaError'
  constructor(message: string) {
    super(message)
  }
}

/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends Error {
  override readonly name = 'ToolArgsError'
  readonly code = 'INVALID_ARGS'
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.violations = violations
  }
}

/* ------------------------------------------------------------- compilation */

/** Annotation keys copied through to the compiled node, in SDK order. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

/** Reject author keys outside one node's declared vocabulary. */
function assertKeys(spec: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      throw new ToolSchemaError(`${path}.${key} is not supported by the value schema DSL`)
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
function copyAnnotations(spec: Record<string, unknown>, node: Record<string, unknown>): void {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(spec, key)) node[key] = spec[key]
  }
}

/** Compile one leaf/array/object node. */
function compileValue(spec: ValueSchemaSpec, path: string): Record<string, unknown> {
  if (spec === null || typeof spec !== 'object') {
    throw new ToolSchemaError(`${path} must be a value schema object`)
  }
  const source = spec as unknown as Record<string, unknown>
  const node: Record<string, unknown> = {}
  const type = source['type']

  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'enum', 'const'])
      node['type'] = type
      copyAnnotations(source, node)
      if (Object.hasOwn(source, 'enum')) {
        const list = source['enum']
        if (!Array.isArray(list)) throw new ToolSchemaError(`${path}.enum must be an array of scalar values`)
        node['enum'] = list.map(entry => entry)
      }
      if (Object.hasOwn(source, 'const')) node['const'] = source['const']
      return node
    }
    case 'array': {
      assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'items'])
      node['type'] = 'array'
      copyAnnotations(source, node)
      if (Object.hasOwn(source, 'items')) {
        node['items'] = compileValue(source['items'] as ValueSchemaSpec, `${path}.items`)
      }
      return node
    }
    case 'object': {
      assertKeys(source, path, ['description', 'title', 'default', 'examples', 'type', 'properties', 'additionalProperties'])
      if (typeof source['additionalProperties'] !== 'boolean') {
        throw new ToolSchemaError(`${path}.additionalProperties must be explicitly true or false`)
      }
      node['type'] = 'object'
      copyAnnotations(source, node)
      node['additionalProperties'] = source['additionalProperties']
      if (Object.hasOwn(source, 'properties')) {
        const compiled = compileParameters(source['properties'] as ParameterSchemaSpec, `${path}.properties`)
        node['properties'] = compiled.properties
        if (compiled.required !== undefined) node['required'] = compiled.required
      }
      return node
    }
    default:
      throw new ToolSchemaError(
        `${path}.type must be string/number/integer/boolean/null/array/object, or use oneOf`,
      )
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
export function compileParameters(spec: ParameterSchemaSpec, path = 'parameters'): ParameterJsonSchema {
  if (spec === null || typeof spec !== 'object') {
    throw new ToolSchemaError(`${path} must be an object`)
  }
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []

  for (const key of Object.keys(spec)) {
    const property = spec[key]
    if (property === undefined || property === null || typeof property !== 'object') {
      throw new ToolSchemaError(`${path}.${key} must be a value schema object`)
    }
    const record = property as unknown as Record<string, unknown>
    if (Object.hasOwn(record, 'required') && record['required'] !== true) {
      throw new ToolSchemaError(`${path}.${key}.required must be true when present`)
    }
    if (record['required'] === true) required.push(key)
    // The `required` marker is author-only; it must not leak into the schema.
    const { required: _required, ...valueSpec } = record
    properties[key] = compileValue(valueSpec as unknown as ValueSchemaSpec, `${path}.${key}`)
  }

  return required.length === 0
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/** Compile a tool's output schema. */
export function compileOutput(spec: ValueSchemaSpec): JsonSchemaNode {
  return compileValue(spec, 'schema')
}

/* ------------------------------------------------------- raw schema checks */

/** Node types this build recognises in a raw schema. */
const RAW_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const

/**
 * Check one raw schema node and its descendants for structural self-consistency.
 *
 * Deliberately *not* a reimplementation of the harness's schema checker, and not
 * claimed to be one: it answers "is this literal schema internally coherent and
 * inside the subset I would accept?", which is what a schema this package owns
 * needs. Anything it cannot judge it rejects rather than waves through.
 */
function checkRawSchema(schema: unknown, path: string, violations: string[]): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  const node = schema as Record<string, unknown>
  const declared = node['type']

  if (declared === undefined) {
    // An annotation-only node is the unconstrained-JSON form.
    if (Object.keys(node).length === 0) return
    violations.push(`${path}.type is missing`)
    return
  }
  if (typeof declared !== 'string' || !(RAW_TYPES as readonly string[]).includes(declared)) {
    violations.push(`${path}.type must be one of ${RAW_TYPES.join('/')}`)
    return
  }

  if (declared === 'object') {
    if (typeof node['additionalProperties'] !== 'boolean') {
      violations.push(`${path}.additionalProperties must be explicitly true or false`)
    }
    const properties = node['properties']
    if (properties !== undefined) {
      if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
        violations.push(`${path}.properties must be an object`)
      } else {
        for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
          checkRawSchema(child, `${path}.properties.${key}`, violations)
        }
      }
    }
    const required = node['required']
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else if (properties !== undefined && properties !== null && typeof properties === 'object') {
        const declaredKeys = new Set(Object.keys(properties as Record<string, unknown>))
        for (const key of required as string[]) {
          if (!declaredKeys.has(key)) violations.push(`${path}.required names "${key}" which is not in properties`)
        }
      }
    }
    return
  }

  if (declared === 'array') {
    if (Object.hasOwn(node, 'items')) checkRawSchema(node['items'], `${path}.items`, violations)
    return
  }

  const allowed = node['enum']
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.length === 0)) {
    violations.push(`${path}.enum must be a non-empty array`)
  }
}

/**
 * Assert a raw schema is object-rooted and structurally self-consistent.
 *
 * Used for the consolidator's `outputSchema`, which the harness requires to be
 * object-rooted.
 */
export function assertObjectJsonSchema(schema: unknown): void {
  const violations: string[] = []
  checkRawSchema(schema, 'schema', violations)
  if (violations.length === 0) {
    const node = schema as Record<string, unknown> | null
    if (node === null || typeof node !== 'object' || node['type'] !== 'object') {
      violations.push('schema.type must be "object" (structured output is object-rooted)')
    }
  }
  if (violations.length > 0) throw new ToolSchemaError(violations.join('; '))
}

/* -------------------------------------------------------------- validation */

/** Whether a value is a lossless JSON value. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value as number)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (kind === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

/** The path prefix the validator reports at the argument root. */
function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

/** Append one object-property path segment without a leading dot at the root. */
function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

function scalarMatches(schema: Record<string, unknown>, value: unknown): boolean {
  switch (schema['type']) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * Validate one value against a compiled schema node.
 *
 * The messages mirror the SDK's shape (`"<path>" must be a <type>`) so a model
 * that learned to read one sees the same guidance from the other.
 */
function checkValue(schema: JsonSchemaNode, value: unknown, path: string, violations: string[]): void {
  if (schema === null || typeof schema !== 'object') {
    violations.push(`"${diagnosticPath(path)}" has an unsupported schema`)
    return
  }
  const node = schema as Record<string, unknown>
  if (Array.isArray(node['oneOf'])) {
    // Not used by the memory tools, but a silent pass would be worse than a
    // refusal: an unsupported node must not validate anything by accident.
    violations.push(`"${diagnosticPath(path)}" uses oneOf, which this build does not validate`)
    return
  }

  const declared = node['type']
  if (declared === undefined) {
    if (!isJsonValue(value)) violations.push(`"${diagnosticPath(path)}" must be a lossless JSON value`)
    return
  }

  if (declared === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`"${diagnosticPath(path)}" must be an object`)
      return
    }
    if (!isJsonValue(value)) {
      violations.push(`"${diagnosticPath(path)}" must be a lossless JSON value`)
      return
    }
    const record = value as Record<string, unknown>
    const properties = (node['properties'] ?? {}) as Record<string, JsonSchemaNode>
    const required = Array.isArray(node['required']) ? (node['required'] as string[]) : []

    for (const key of Object.keys(record)) {
      const child = properties[key]
      if (child === undefined) {
        if (node['additionalProperties'] === false) {
          violations.push(`"${propertyPath(path, key)}" is not a declared property`)
        }
        continue
      }
      checkValue(child, record[key], propertyPath(path, key), violations)
    }
    for (const key of required) {
      if (!Object.hasOwn(record, key)) {
        violations.push(`"${propertyPath(path, key)}" is required`)
      }
    }
    return
  }

  if (declared === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`"${diagnosticPath(path)}" must be an array`)
      return
    }
    const items = node['items']
    if (items === undefined) return
    value.forEach((entry, index) => {
      checkValue(items as JsonSchemaNode, entry, `${path}[${index}]`, violations)
    })
    return
  }

  if (!scalarMatches(node, value)) {
    violations.push(`"${diagnosticPath(path)}" must be a ${String(declared)}`)
    return
  }
  const allowed = node['enum']
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    violations.push(`"${diagnosticPath(path)}" must be one of ${allowed.map(entry => JSON.stringify(entry)).join(', ')}`)
    return
  }
  if (Object.hasOwn(node, 'const') && node['const'] !== value) {
    violations.push(`"${diagnosticPath(path)}" must be ${JSON.stringify(node['const'])}`)
  }
}

/**
 * Validate model-generated arguments against a parameter schema.
 *
 * Two entry points, matching the SDK's: author code holds the DSL spec, while a
 * compiled definition holds the raw schema.
 *
 * @returns Path-qualified violations; empty means valid.
 */
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[]
export function validateArgs(schema: ParameterJsonSchema, args: unknown): string[]
export function validateArgs(specOrSchema: ParameterSchemaSpec | ParameterJsonSchema, args: unknown): string[] {
  const looksCompiled = (specOrSchema as ParameterJsonSchema).type === 'object'
    && Object.hasOwn(specOrSchema as object, 'properties')
  const schema = looksCompiled
    ? specOrSchema as ParameterJsonSchema
    : compileParameters(specOrSchema as ParameterSchemaSpec)

  if (args === undefined || args === null) {
    // A call with no arguments is the common case for a tool that declares none,
    // and for one that declares only optional fields. A missing required field is
    // reported the same way the object walk reports it.
    const required = Array.isArray(schema.required) ? schema.required : []
    const violations = required.map(key => `"${key}" is required`)
    if (violations.length > 0) return violations
    return args === null ? ['"arguments" must be an object'] : []
  }
  const violations: string[] = []
  checkValue(schema, args, '', violations)
  return violations
}

/* ------------------------------------------------------------------ helper */

/**
 * Define a tool with strict argument validation.
 *
 * Mirrors the SDK's `defineTool` for the subset described in the module doc:
 * the body is not invoked unless the arguments validate, and an invalid call
 * throws {@link ToolArgsError} carrying every violation.
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  const parameters = compileParameters(options.parameters)
  const outputSchema = compileOutput(options.output.schema)
  const userRender = options.output.render

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args: unknown, value: JsonValue): TextContentBlock[] {
        return userRender(args as InferArgs<S>, value as InferValue<O>)
      },
    },
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return await options.execute(args as InferArgs<S>, exec)
    },
  }
}
