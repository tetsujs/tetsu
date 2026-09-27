/**
 * The shape the document gives an error.
 *
 * Every failure an application answers with reaches its `onError` hooks,
 * so one hook sets the format of all of them. The document is generated
 * from the routes, not from that hook, and cannot see what it does: an
 * application with a format of its own says so here too, and the framework's
 * failures, the hooks' refusals and the routes' own envelopes are described
 * in it. Keeping the two in step is the application's to do — the core knows
 * nothing about documents, and a function cannot be read for the shape it
 * returns.
 *
 * Without it the format is the framework's envelope,
 * `{ status, message, error }`.
 *
 * @module
 */

import type { JsonSchemaObject } from "./emit.ts";
import type { JsonSchema, JsonSchemaKeywords } from "./json-schema.ts";

/**
 * One failure the document describes, as the generator knows it.
 *
 * This is everything known about a failure before it is answered: its
 * status, its code when the framework or the hook knows it, an example of
 * its message, and what else it carries — the `issues` of a validation
 * failure, the `retryAfter` of a rate limit. Where each goes in the body
 * is the format's to decide.
 */
export interface DocumentedFailure {
  readonly status: number;

  /** The code a client branches on, when it is known. */
  readonly error?: string;

  /** An example of the message; wording, never a contract. */
  readonly message?: string;

  /** What the failure carries besides, as JSON Schema by name. */
  readonly fields: Readonly<Record<string, JsonSchema>>;
}

/** How the application's errors look, for the document to describe them. */
export interface ErrorFormat {
  /** The body of one failure. */
  readonly schema: (failure: DocumentedFailure) => JsonSchemaKeywords;

  /**
   * The top-level field that holds the code, for a client to discriminate
   * on — `"code"` in `{ code, message }`. A status whose alternatives are
   * all envelopes then carries a `discriminator` on it.
   *
   * None unless named: OpenAPI discriminates on a top-level field only, and
   * a format that nests its code — `{ error: { code } }` — has none to
   * name.
   */
  readonly discriminator?: string;

  /**
   * The code of a schema a route or a hook declared, when it is an
   * envelope in this format — how the document knows a route's own `404`
   * is the same failure as a hook's, and gives both one definition.
   *
   * Read off the JSON Schema the validator emitted. By default, the
   * `const` of the discriminator's field, when there is one; a nested
   * format says where its code is.
   */
  readonly code?: (schema: JsonSchemaKeywords) => string | undefined;
}

/** What the generator works with: every part of a format, filled in. */
export interface ResolvedFormat {
  describe(failure: DocumentedFailure): JsonSchemaObject;
  code(schema: JsonSchemaObject): string | undefined;
  readonly discriminator: string | undefined;
}

/**
 * A format as the generator uses it. Absent, the framework's envelope,
 * discriminated on `error`.
 */
export function resolveFormat(format: ErrorFormat | undefined): ResolvedFormat {
  if (format === undefined) {
    return {
      describe: envelope,
      code: codeIn("error"),
      discriminator: "error",
    };
  }

  const discriminator = format.discriminator;
  const read = format.code;

  return {
    describe: (failure) => format.schema(failure) as JsonSchemaObject,
    code: read
      ? (schema) => read(schema as JsonSchemaKeywords)
      : discriminator === undefined
        ? () => undefined
        : codeIn(discriminator),
    discriminator,
  };
}

/**
 * The body of one failure in the framework's envelope, as JSON Schema.
 *
 * The status is a `const`, and so is the code whenever it is known: a
 * generated client can then discriminate on `error` instead of receiving
 * "an object with three strings", and a reader of the document sees
 * `"BODY_TOO_LARGE"` rather than `string`.
 *
 * The message is documented by example, never as a `const` — it is wording
 * meant for a human, the one field a client must not match on, and the one
 * this project reserves the right to reword.
 *
 * Fields a failure carries besides come after the three, and never in
 * their place.
 */
function envelope(failure: DocumentedFailure): JsonSchemaObject {
  const own = {
    status: { type: "integer", const: failure.status },
    message: failure.message
      ? { type: "string", examples: [failure.message] }
      : { type: "string" },
    error: failure.error
      ? { type: "string", const: failure.error }
      : { type: "string" },
  };

  const added = Object.keys(failure.fields).filter(
    (name) => !Object.hasOwn(own, name),
  );

  return {
    type: "object",
    required: ["status", "message", "error", ...added],
    properties: { ...failure.fields, ...own },
  };
}

/**
 * Reads the code of an envelope from one top-level field: required, and
 * holding one string — a `const`, or an `enum` of one value.
 */
function codeIn(
  field: string,
): (schema: JsonSchemaObject) => string | undefined {
  return (schema) => {
    const required = Array.isArray(schema.required) ? schema.required : [];

    if (!required.includes(field)) {
      return undefined;
    }

    const value = (
      schema.properties as
        | Record<string, { const?: unknown; enum?: unknown } | undefined>
        | undefined
    )?.[field];

    if (typeof value?.const === "string") {
      return value.const;
    }

    if (
      Array.isArray(value?.enum) &&
      value.enum.length === 1 &&
      typeof value.enum[0] === "string"
    ) {
      return value.enum[0];
    }

    return undefined;
  };
}
