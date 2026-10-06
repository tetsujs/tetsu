/**
 * Type-level tests for what a hook, or a handler, says about itself.
 *
 * @module
 */

import type { AnyHook, BaseCtx } from "@tetsujs/core";
import { hook } from "@tetsujs/core";
import type { SecurityRequirement } from "./annotations.ts";
import { documented } from "./annotations.ts";

const refusal = hook.beforeParse(() => undefined);

export const accepted = documented(refusal, {
  responses: [
    {
      status: 429,
      description: "Too many requests",
      error: "RATE_LIMITED",
      fields: {
        retryAfter: { type: "integer", minimum: 0 },
        window: { type: ["string", "null"], format: "duration" },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        anything: true,
        vendor: { type: "string", "x-internal": true },
      },
      headers: {
        "retry-after": {
          description: "Seconds until the window resets",
          schema: { type: "integer", minimum: 0 },
        },
      },
    },
  ],
});

export const misspelledKeyword = documented(refusal, {
  responses: [
    {
      status: 429,
      description: "Too many requests",
      // @ts-expect-error `minimun` is not a keyword; the document would carry it silently
      fields: { retryAfter: { type: "integer", minimun: 0 } },
    },
  ],
});

export const unknownType = documented(refusal, {
  responses: [
    {
      status: 429,
      description: "Too many requests",
      // @ts-expect-error `int` is not a JSON Schema type
      fields: { retryAfter: { type: "int" } },
    },
  ],
});

export const misspelledNested = documented(refusal, {
  responses: [
    {
      status: 429,
      description: "Too many requests",
      fields: {
        // @ts-expect-error the check reaches subschemas, not only the top
        tags: { type: "array", items: { type: "string", maxLenght: 3 } },
      },
    },
  ],
});

export const headerWithoutSchema = documented(refusal, {
  responses: [
    {
      status: 429,
      description: "Too many requests",
      // @ts-expect-error a header is described by its schema
      headers: { "retry-after": { description: "Seconds" } },
    },
  ],
});

/** A handler is annotated as a hook is, and keeps its type. */
const serveFile = (ctx: BaseCtx) => new Response(ctx.req.url);

export const annotatedHandler: typeof serveFile = documented(serveFile, {
  hidden: true,
  responses: [
    {
      status: 200,
      description: "The file",
      contentType: "image/*",
      headers: { etag: { schema: { type: "string" } } },
    },
    { status: 304, description: "Not modified" },
  ],
});

export const handlerTypeKept: (ctx: BaseCtx) => Response = annotatedHandler;

export const misspelledHidden = documented(serveFile, {
  // @ts-expect-error `hiden` is not a field: the check reaches the top level
  hiden: true,
});

export const handlerMisspelledHeader = documented(serveFile, {
  responses: [
    {
      status: 200,
      description: "The file",
      // @ts-expect-error the check reaches a handler's headers as a hook's
      headers: { etag: { schema: { type: "string", maxLenght: 3 } } },
    },
  ],
});

export const contentTypeNumber = documented(serveFile, {
  responses: [
    {
      status: 200,
      description: "The file",
      // @ts-expect-error a media type is a string
      contentType: 415,
    },
  ],
});

/** A helper generic in the handler compiles, and can hide what it serves. */
export function hiddenFiles<F extends (ctx: BaseCtx) => Promise<Response>>(
  handler: F,
): F {
  return documented(handler, { hidden: true });
}

/** A helper generic in the hook compiles, as `secured()` itself is one. */
export function withScheme<H extends AnyHook>(
  hook: H,
  requirement: SecurityRequirement,
): H {
  return documented(hook, { security: requirement });
}
