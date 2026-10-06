/**
 * Error envelopes, one definition per status and code.
 *
 * An envelope reaches a document from five directions: a route's response
 * map, its handler's annotation, a hook's annotation, a guard's security
 * requirement, and the framework's own failures. Each used to be described
 * where it arrived —
 * a route's inline, the rest by reference — so one `UNAUTHORIZED` could be
 * listed twice under one status, once as a `$ref` and once as the same
 * shape without a name, and a generated client got a named type next to an
 * anonymous twin.
 *
 * Here every envelope, whoever declared it, becomes a reference to the
 * one definition of its status and code. That is also what makes a status
 * discriminable: a client can branch on `error` only if every code under
 * the status has exactly one shape.
 *
 * The route's definition wins, its handler's annotation counting as the
 * route's own. It is the author's own contract — usually the stricter one,
 * a validator's `additionalProperties: false` — where a hook's is the
 * framework's generic envelope. The routes are therefore read first,
 * before any operation is built, so the winner does not depend on which
 * route happens to come first in the table.
 *
 * What an envelope looks like — how one is described, where its code is,
 * what a client discriminates on — is the document's error format, which
 * the registry carries for everything that builds or reads one.
 *
 * Internal to the package.
 *
 * @module
 */

import type { SchemaComponents, SchemaRef } from "./components.ts";
import { failureName } from "./components.ts";
import type { JsonSchemaObject } from "./emit.ts";
import type { ResolvedFormat } from "./errors.ts";

/** The definitions of every envelope of one document. */
export interface Envelopes {
  /** The document's error format. */
  readonly format: ResolvedFormat;

  /**
   * Records a route's definition, before anything is referenced. The first
   * route to declare a status and code defines it.
   */
  declare(status: number, code: string, schema: JsonSchemaObject): void;

  /**
   * The reference to the definition of a status and code.
   *
   * `schema` is how the caller describes it. When a definition already
   * exists, that is what is referenced; if the caller's differs from it
   * in fields, `warn` hears about it — once per document, not once per
   * operation the hook runs on.
   */
  ref(
    status: number,
    code: string,
    schema: JsonSchemaObject,
    warn: (message: string) => void,
  ): SchemaRef;

  /**
   * The code a reference stands for, when it is one this handed out — what
   * a discriminator maps back from.
   */
  codeOf(ref: string): string | undefined;
}

export function envelopes(
  components: SchemaComponents,
  format: ResolvedFormat,
): Envelopes {
  const declared = new Map<string, JsonSchemaObject>();
  const defined = new Map<string, JsonSchemaObject>();
  const refs = new Map<string, SchemaRef>();
  const codes = new Map<string, string>();
  const names = new Map<string, string>();
  const reported = new Set<string>();

  return {
    format,

    declare(status, code, schema) {
      const key = keyOf(status, code);

      if (!declared.has(key)) {
        declared.set(key, schema);
      }
    },

    ref(status, code, schema, warn) {
      const key = keyOf(status, code);
      const definition = declared.get(key) ?? defined.get(key) ?? schema;

      defined.set(key, definition);

      const difference = differenceOf(definition, schema);

      if (difference && !reported.has(`${key} ${difference}`)) {
        reported.add(`${key} ${difference}`);
        warn(
          `the ${status} "${code}" is described by one definition in the document, and a definition that differs from it in ${difference} is not described`,
        );
      }

      const existing = refs.get(key);

      if (existing) {
        return existing;
      }

      const created = components.ref(nameOf(status, code), definition);

      refs.set(key, created);
      codes.set(created.$ref, code);

      return created;
    },

    codeOf(ref) {
      return codes.get(ref);
    },
  };

  /**
   * The name a status and code are defined under: the code's, unless the
   * same code under another status has it already, in which case the
   * status tells the two apart — `Invalid` and `Invalid409`.
   */
  function nameOf(status: number, code: string): string {
    const name = failureName(status, code);
    const holder = names.get(name);

    if (holder === undefined || holder === keyOf(status, code)) {
      names.set(name, keyOf(status, code));

      return name;
    }

    return `${name}${status}`;
  }
}

/**
 * The alternatives a schema stands for, as a list the status's own union
 * can take in.
 *
 * `anyOf` nested in `anyOf` says nothing its branches do not say side by
 * side, so a schema that is only an `anyOf` is replaced by its branches.
 * A `oneOf` is different — "exactly one" of two overlapping shapes refuses
 * what both accept — and is taken apart only when its branches cannot
 * overlap: envelopes with a different code each. A schema with anything
 * beside its union, a `title` or a `$defs`, is left whole: those keywords
 * belong to the union, and would be lost with it.
 */
export function branchesOf(
  schema: JsonSchemaObject,
  code: (schema: JsonSchemaObject) => string | undefined,
): JsonSchemaObject[] {
  const keys = Object.keys(schema);

  if (keys.length !== 1) {
    return [schema];
  }

  const within = (branch: JsonSchemaObject) => branchesOf(branch, code);

  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchemaObject[]).flatMap(within);
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = (schema.oneOf as JsonSchemaObject[]).flatMap(within);
    const codes = branches.map(code);

    if (
      codes.every((code) => code !== undefined) &&
      new Set(codes).size === codes.length
    ) {
      return branches;
    }
  }

  return [schema];
}

function keyOf(status: number, code: string): string {
  return `${status} ${code}`;
}

/**
 * How two definitions of one envelope differ in what a client reads: the
 * fields one has and the other does not, or which of them are required —
 * at any depth, by path, so a format that nests its fields
 * (`error.retryAfter`) is compared as closely as a flat one. Wording — a
 * `message` example, `number` against `integer` for the status — is not a
 * difference a client would notice, and is not one.
 */
function differenceOf(
  kept: JsonSchemaObject,
  other: JsonSchemaObject,
): string | undefined {
  const keptShape = shapeOf(kept);
  const otherShape = shapeOf(other);

  const changed = [
    ...otherShape.fields.filter((path) => !keptShape.fields.includes(path)),
    ...keptShape.fields.filter((path) => !otherShape.fields.includes(path)),
  ];

  if (changed.length > 0) {
    return `fields: ${changed.join(", ")}`;
  }

  return JSON.stringify(keptShape.required) ===
    JSON.stringify(otherShape.required)
    ? undefined
    : "which fields are required";
}

/** How deep {@link shapeOf} looks; an envelope is a few levels at most. */
const shapeDepth = 8;

/**
 * The paths of an object schema's fields, and of the required ones among
 * them, following `properties` down. Sorted, so two shapes compare as
 * strings.
 */
function shapeOf(schema: JsonSchemaObject): {
  fields: string[];
  required: string[];
} {
  const fields: string[] = [];
  const required: string[] = [];

  const walk = (node: JsonSchemaObject, prefix: string, depth: number) => {
    const properties = node.properties;

    if (
      depth > shapeDepth ||
      properties === null ||
      typeof properties !== "object"
    ) {
      return;
    }

    const requiredHere = Array.isArray(node.required) ? node.required : [];

    for (const [name, child] of Object.entries(properties)) {
      const path = `${prefix}${name}`;

      fields.push(path);

      if (requiredHere.includes(name)) {
        required.push(path);
      }

      if (child !== null && typeof child === "object") {
        walk(child as JsonSchemaObject, `${path}.`, depth + 1);
      }
    }
  };

  walk(schema, "", 0);

  return { fields: fields.sort(), required: required.sort() };
}
