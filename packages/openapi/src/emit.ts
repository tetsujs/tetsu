/**
 * Asking a schema to describe itself, without letting it stop the document.
 *
 * Internal to the package.
 *
 * @module
 */

import { toJsonSchema } from "@tetsujs/core";

/**
 * The JSON Schema dialect a schema is asked for.
 *
 * OpenAPI 3.1 takes JSON Schema 2020-12 as it is, and `draft-2020-12` is a
 * target the Standard JSON Schema specification names — so every library
 * that implements it answers. This used to be `openapi-3.1`, which only
 * Zod accepts: ArkType and Valibot refused it, and their bodies went into
 * the document without a shape and with a warning each.
 */
const target = { target: "draft-2020-12" } as const;

/**
 * A JSON Schema as the generator reads it: any keyword, with the two it
 * looks into named, so reading them does not depend on the reader's
 * `noPropertyAccessFromIndexSignature`.
 */
export interface JsonSchemaObject {
  properties?: unknown;
  required?: unknown;
  [keyword: string]: unknown;
}

/** Which shape of a schema to describe: what arrives, or what leaves. */
type Direction = "input" | "output";

/**
 * The JSON Schema of a declaration, or `undefined` and a warning saying why.
 *
 * A schema can fail to describe itself in two ways, and the generator owes
 * the same answer to both: an adapter without JSON Schema support returns
 * nothing, and an adapter that has it can still throw — a converter meeting
 * a shape it cannot express, a structure too deep to walk, a `$ref` that
 * leads back to where it started.
 *
 * Only the first was handled, and the difference between them is not the
 * document: it is whether the application starts at all. `docs()` builds
 * the document from `onMount`, which `createApp` calls while it is still
 * assembling itself, so an escaping error is not a gap in a description —
 * it is a server that never listens, over a route that would have worked.
 *
 * `subject` names the declaration for the message, as the reader of a
 * warning would name it: `"the body"`, `"a response"`.
 */
export function emitted(
  schema: unknown,
  subject: string,
  warn: (message: string) => void,
  direction: Direction = "output",
): JsonSchemaObject | undefined {
  let described: JsonSchemaObject | undefined;

  try {
    described = toJsonSchema(schema, target, direction);
  } catch (error) {
    warn(`${subject} schema failed to emit JSON Schema: ${reason(error)}`);

    return undefined;
  }

  if (!described) {
    warn(`${subject} schema does not emit JSON Schema`);

    return undefined;
  }

  return withoutDialect(described);
}

/**
 * A schema as the document embeds it: without its own `$schema`.
 *
 * Asked for draft 2020-12, Zod and ArkType name the dialect at the root of
 * every schema they emit. The document declares it once for all of them,
 * and the same line on every body and response is noise.
 */
function withoutDialect(schema: JsonSchemaObject): JsonSchemaObject {
  if (!("$schema" in schema)) {
    return schema;
  }

  const { $schema: _, ...rest } = schema;

  return rest;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
