/**
 * Type-level tests for what a hook says about itself.
 *
 * @module
 */

import { hook } from "@tetsujs/core";
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
