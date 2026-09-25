/**
 * JSON Schema 2020-12, as written by hand.
 *
 * Every other schema in a document comes from a validator, which describes
 * itself. What a hook adds to its answer — a field next to the envelope, a
 * header — has no validator behind it, and is written as JSON Schema
 * directly. Typed closed, keyword by keyword, so that an editor offers the
 * keywords and a misspelled one is an error: an open record would take
 * `minimun` and `{ type: "int" }` and put them in the document as they are.
 *
 * Closed on purpose, not by omission. The generator asks every schema for
 * the 2020-12 dialect, and a dialect's keywords are a fixed list. The one
 * open door is what OpenAPI itself allows in a schema — extensions, named
 * `x-` — and no misspelling of a keyword starts with it.
 *
 * @module
 */

/** A primitive type name of JSON Schema. */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

/**
 * A schema: an object of keywords, or `true` and `false` — the schemas
 * everything and nothing satisfy.
 *
 * @example
 * ```ts
 * const retryAfter: JsonSchema = { type: "integer", minimum: 0 };
 * ```
 */
export type JsonSchema = JsonSchemaKeywords | boolean;

/** The keywords of JSON Schema 2020-12. */
export interface JsonSchemaKeywords {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $anchor?: string;
  readonly $dynamicRef?: string;
  readonly $dynamicAnchor?: string;
  readonly $vocabulary?: Readonly<Record<string, boolean>>;
  readonly $comment?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;

  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;

  readonly multipleOf?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;

  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly contentEncoding?: string;
  readonly contentMediaType?: string;
  readonly contentSchema?: JsonSchema;

  readonly prefixItems?: readonly JsonSchema[];
  readonly items?: JsonSchema;
  readonly contains?: JsonSchema;
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxContains?: number;
  readonly minContains?: number;
  readonly unevaluatedItems?: JsonSchema;

  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly patternProperties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: JsonSchema;
  readonly unevaluatedProperties?: JsonSchema;
  readonly propertyNames?: JsonSchema;
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly dependentSchemas?: Readonly<Record<string, JsonSchema>>;
  readonly maxProperties?: number;
  readonly minProperties?: number;

  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly else?: JsonSchema;

  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly unknown[];

  readonly [extension: `x-${string}`]: unknown;
}
