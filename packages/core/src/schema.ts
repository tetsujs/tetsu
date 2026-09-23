/**
 * Vendored type definitions for the Standard Schema v1 specification.
 *
 * Standard Schema is a common interface implemented by TypeScript validation
 * libraries such as Zod, Valibot and ArkType. The framework accepts this
 * interface instead of a concrete library: the core stays zero-dependency
 * while users bring the validator of their choice.
 *
 * Validators that do not implement the specification (e.g. TypeBox) can be
 * plugged in through a small adapter that wraps their compiled checker into
 * the `~standard.validate` call.
 *
 * The definitions mirror `@standard-schema/spec` version 1.1.0 with its
 * namespaces flattened into prefixed exports. Updating means copying the
 * package's declarations again and re-flattening them — the spec changes
 * rarely and deliberately.
 *
 * @see https://standardschema.dev
 * @module
 */

/**
 * The base interface shared by everything carrying inferred types — both
 * validators and JSON Schema converters.
 *
 * @typeParam Input - The type this schema accepts.
 * @typeParam Output - The type produced by successful validation.
 */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardTypedProps<Input, Output>;
}

/**
 * The properties every Standard-compliant value carries.
 */
export interface StandardTypedProps<Input = unknown, Output = Input> {
  /** The version of the Standard Schema specification. */
  readonly version: 1;

  /** The name of the validator library, e.g. `"zod"`. */
  readonly vendor: string;

  /** Inference helper carrying the input and output types; never set at runtime. */
  readonly types?: StandardTypes<Input, Output> | undefined;
}

/**
 * A validation schema conforming to the Standard Schema v1 specification.
 *
 * Any value with a spec-compliant `~standard` property is accepted wherever
 * the framework expects a schema — route `schema.body`, `schema.query`, etc.
 *
 * @typeParam Input - The type this schema accepts for validation.
 * @typeParam Output - The type produced by successful validation.
 *
 * @example Using a Zod schema (Zod implements the spec natively)
 * ```ts
 * import { z } from "zod";
 *
 * const CreateUser = z.object({ email: z.string().email() });
 *
 * const schema: StandardSchemaV1<unknown, { email: string }> = CreateUser;
 * ```
 *
 * @example Writing an adapter for a non-compliant validator
 * ```ts
 * function fromPredicate<T>(check: (value: unknown) => value is T): StandardSchemaV1<unknown, T> {
 *   return {
 *     "~standard": {
 *       version: 1,
 *       vendor: "custom",
 *       validate: (value) =>
 *         check(value) ? { value } : { issues: [{ message: "Invalid value" }] },
 *     },
 *   };
 * }
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

/**
 * The contents of a validating schema's `~standard` property.
 */
export interface StandardSchemaProps<Input = unknown, Output = Input>
  extends StandardTypedProps<Input, Output> {
  /** Validates a value; may be synchronous or asynchronous. */
  readonly validate: (
    value: unknown,
    options?: StandardValidateOptions | undefined,
  ) => StandardResult<Output> | Promise<StandardResult<Output>>;
}

/** Extra parameters passed through to the validator library. */
export interface StandardValidateOptions {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * A schema able to describe itself as JSON Schema.
 *
 * Independent of validation: a value may convert to JSON Schema, validate,
 * or both. OpenAPI generation reads this interface, which is why route
 * schemas double as the single source of truth for documentation.
 *
 * @example
 * ```ts
 * function toOpenApi(schema: StandardJSONSchemaV1): Record<string, unknown> {
 *   return schema["~standard"].jsonSchema.output({ target: "openapi-3.0" });
 * }
 * ```
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardJSONSchemaProps<Input, Output>;
}

/**
 * The contents of a convertible schema's `~standard` property.
 */
export interface StandardJSONSchemaProps<Input = unknown, Output = Input>
  extends StandardTypedProps<Input, Output> {
  /** Methods generating the input/output JSON Schema. */
  readonly jsonSchema: StandardJSONSchemaConverter;
}

/**
 * Converts a schema to JSON Schema. Both methods may throw when the
 * requested target is not supported by the library.
 */
export interface StandardJSONSchemaConverter {
  /** JSON Schema of the accepted input. */
  readonly input: (
    options: StandardJSONSchemaOptions,
  ) => Record<string, unknown>;

  /** JSON Schema of the validated output. */
  readonly output: (
    options: StandardJSONSchemaOptions,
  ) => Record<string, unknown>;
}

/**
 * The JSON Schema dialect to generate.
 *
 * Libraries are expected to support `"draft-2020-12"` and `"draft-07"`;
 * `"openapi-3.0"` is the standardized specifier for the OpenAPI 3.0 dialect.
 */
export type StandardJSONSchemaTarget =
  | "draft-2020-12"
  | "draft-07"
  | "openapi-3.0"
  | ({} & string);

/** Options for the JSON Schema converter. */
export interface StandardJSONSchemaOptions {
  readonly target: StandardJSONSchemaTarget;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * Phantom property used by the specification to carry inferred types.
 */
export interface StandardTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

/**
 * The outcome of running a schema: either a validated value or a list of issues.
 */
export type StandardResult<Output> = StandardSuccess<Output> | StandardFailure;

/**
 * A successful validation result.
 *
 * The `value` may differ from the input when the schema transforms it
 * (coercion, defaults, stripping of unknown keys).
 */
export interface StandardSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

/** A failed validation result carrying one or more issues. */
export interface StandardFailure {
  readonly issues: readonly StandardIssue[];
}

/** A single validation issue, e.g. one invalid field. */
export interface StandardIssue {
  /** Human-readable description of the problem. */
  readonly message: string;

  /** Location of the problem inside the validated value, when applicable. */
  readonly path?: readonly (PropertyKey | StandardPathSegment)[] | undefined;
}

/** An object-wrapped path key, used by validators whose keys carry metadata. */
export interface StandardPathSegment {
  readonly key: PropertyKey;
}

/**
 * The widest schema type: any Standard Schema regardless of its input and
 * output. Used as a constraint wherever the framework accepts "some schema".
 *
 * Output positions of the interface are covariant, so every concrete schema
 * is assignable to `AnySchema` without resorting to `any`.
 */
export type AnySchema = StandardSchemaV1<unknown, unknown>;

/**
 * Extracts the input type of a schema.
 *
 * @example
 * ```ts
 * type Input = InferInput<typeof CreateUser>;
 * ```
 */
export type InferInput<S extends StandardTypedV1> = NonNullable<
  S["~standard"]["types"]
>["input"];

/**
 * Extracts the output type of a schema — the single piece of type information
 * the framework reads from a validator. Route context fields (`ctx.body`,
 * `ctx.query`, ...) are typed with the output of the corresponding schema.
 *
 * @example
 * ```ts
 * const CreateUser = z.object({ email: z.string().email() });
 *
 * type Body = InferOutput<typeof CreateUser>;
 * //   ^? { email: string }
 * ```
 */
export type InferOutput<S extends StandardTypedV1> = NonNullable<
  S["~standard"]["types"]
>["output"];

/**
 * Which side of a schema to read.
 *
 * A coercing schema has two shapes: `"input"` is what a client may send
 * (`"42"`), `"output"` is what validation produces (`42`). Request parts
 * are documented by their input, responses by their output.
 */
export type JsonSchemaDirection = "input" | "output";

/**
 * Reads the JSON Schema of a value when it supports conversion.
 *
 * Returns `undefined` for schemas without native support — documentation
 * tooling can then fall back to a converter package instead of failing.
 *
 * @example
 * ```ts
 * const jsonSchema = toJsonSchema(CreateUser, { target: "openapi-3.1" });
 *
 * const asSent = toJsonSchema(Params, { target: "openapi-3.1" }, "input");
 * ```
 */
export function toJsonSchema(
  schema: unknown,
  options: StandardJSONSchemaOptions,
  direction: JsonSchemaDirection = "output",
): Record<string, unknown> | undefined {
  const props = (schema as Partial<StandardJSONSchemaV1>)?.["~standard"];

  if (!props || !("jsonSchema" in props)) {
    return undefined;
  }

  return props.jsonSchema[direction](options);
}
