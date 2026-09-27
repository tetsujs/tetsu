/**
 * Tests for describing errors in a format of the application's own.
 *
 * An application that answers failures in its own shape — through an
 * `onError` hook on the application, which every failure reaches — tells
 * the generator that shape with `errors`, and the document describes the
 * framework's failures, the hooks' refusals and the routes' own envelopes
 * in it.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import type { OpenApiDocument } from "./document.ts";
import type { DocumentedFailure, ErrorFormat } from "./index.ts";
import { documented, openapi } from "./index.ts";

/** A schema that describes itself as the given JSON Schema. */
const described = (jsonSchema: Record<string, unknown>): StandardSchemaV1 =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1;

const info = { title: "Errors", version: "1" };

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const schemaOf = (
  document: OpenApiDocument,
  path: string,
  method: string,
  status: string,
): Record<string, unknown> | undefined =>
  document.paths[path]?.[method]?.responses[status]?.content?.[
    "application/json"
  ]?.schema;

const componentsOf = (document: OpenApiDocument): Record<string, unknown> =>
  (document.components?.schemas ?? {}) as Record<string, unknown>;

/** `{ code, message }` at the top, and whatever else a failure carries. */
const flat: ErrorFormat = {
  schema: ({ error, message, fields }) => ({
    type: "object",
    required: ["code", "message", ...Object.keys(fields)],
    properties: {
      code: error ? { type: "string", const: error } : { type: "string" },
      message: message
        ? { type: "string", examples: [message] }
        : { type: "string" },
      ...fields,
    },
  }),
  discriminator: "code",
};

const limited = documented(
  hook.beforeParse(() => undefined),
  {
    responses: [
      {
        status: 429,
        description: "Too many",
        error: "RATE_LIMITED",
        fields: { retryAfter: { type: "integer", minimum: 0 } },
      },
    ],
  },
);

const flatEnvelope = (error: string) => ({
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string", const: error },
    message: { type: "string" },
  },
  additionalProperties: false,
});

describe("a format of the application's own", () => {
  const seen: DocumentedFailure[] = [];

  const recording: ErrorFormat = {
    ...flat,
    schema: (failure) => {
      seen.push(failure);

      return flat.schema(failure);
    },
  };

  const app = createApp({
    routes: {
      create: route({
        method: "POST",
        path: "/items",
        hooks: { beforeParse: [limited] },
        schema: {
          body: described({ type: "object" }),
          response: {
            201: described({ type: "object" }),
            429: described(flatEnvelope("TOO_MANY_ATTEMPTS")),
          },
        },
        handler: () => ({}),
      }),
    },
  });

  const { document } = openapi(app, { info, errors: recording });

  test("describes the framework's own failures", () => {
    expect(componentsOf(document).InternalServerError).toEqual(
      flat.schema({
        status: 500,
        error: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
        fields: {},
      }),
    );
    expect(schemaOf(document, "/items", "post", "413")).toEqual(
      ref("BodyTooLarge"),
    );
  });

  test("hands a validation failure its issues as a field", () => {
    const validation = seen.find((failure) => failure.status === 422);

    expect(validation?.error).toBe("VALIDATION_FAILED");
    expect(Object.keys(validation?.fields ?? {})).toEqual(["issues"]);
    expect(componentsOf(document).ValidationFailed).toMatchObject({
      required: ["code", "message", "issues"],
    });
  });

  test("hands a hook's own fields over, for the format to place", () => {
    const refusal = seen.find((failure) => failure.error === "RATE_LIMITED");

    expect(refusal?.fields).toEqual({
      retryAfter: { type: "integer", minimum: 0 },
    });
  });

  test("recognizes the route's envelopes by the discriminator's field", () => {
    expect(schemaOf(document, "/items", "post", "429")).toEqual({
      anyOf: [ref("TooManyAttempts"), ref("RateLimited")],
      discriminator: {
        propertyName: "code",
        mapping: {
          TOO_MANY_ATTEMPTS: "#/components/schemas/TooManyAttempts",
          RATE_LIMITED: "#/components/schemas/RateLimited",
        },
      },
    });
  });
});

describe("without a discriminator", () => {
  const app = createApp({
    routes: {
      create: route({
        method: "POST",
        path: "/items",
        hooks: { beforeParse: [limited] },
        schema: {
          response: {
            201: described({ type: "object" }),
            429: described(flatEnvelope("TOO_MANY_ATTEMPTS")),
          },
        },
        handler: () => ({}),
      }),
    },
  });

  test("a status of envelopes is a plain union", () => {
    const { document } = openapi(app, {
      info,
      errors: { schema: flat.schema },
    });

    const refusals = schemaOf(document, "/items", "post", "429");

    expect(refusals?.discriminator).toBeUndefined();
    expect(refusals?.anyOf).toContainEqual(ref("RateLimited"));
  });

  test("the route's envelopes are recognized by the format's code", () => {
    const { document } = openapi(app, {
      info,
      errors: {
        schema: flat.schema,
        code: (schema) => {
          const code = schema.properties?.code;

          return typeof code === "object" && typeof code.const === "string"
            ? code.const
            : undefined;
        },
      },
    });

    const refusals = schemaOf(document, "/items", "post", "429");

    expect(refusals?.anyOf).toEqual([
      ref("TooManyAttempts"),
      ref("RateLimited"),
    ]);
    // Every alternative is an envelope, and still no discriminator: the
    // format named no field, and `error` is not one of its fields.
    expect(refusals?.discriminator).toBeUndefined();
  });
});

describe("a nested format", () => {
  /** `{ error: { code, message, … } }` — the code is not at the top. */
  const nested: ErrorFormat = {
    schema: ({ error, fields }) => ({
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message", ...Object.keys(fields)],
          properties: {
            code: error ? { type: "string", const: error } : { type: "string" },
            message: { type: "string" },
            ...fields,
          },
        },
      },
    }),
    code: (schema) => {
      const error = schema.properties?.error;
      const code =
        typeof error === "object" ? error.properties?.code : undefined;

      return typeof code === "object" && typeof code.const === "string"
        ? code.const
        : undefined;
    },
  };

  const routeEnvelope = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", const: "RATE_LIMITED" },
          message: { type: "string" },
        },
      },
    },
  };

  const app = createApp({
    hooks: { beforeParse: [limited] },
    routes: {
      create: route({
        method: "POST",
        path: "/items",
        schema: {
          response: {
            201: described({ type: "object" }),
            429: described(routeEnvelope),
          },
        },
        handler: () => ({}),
      }),
    },
  });

  const { document, warnings } = openapi(app, { info, errors: nested });

  test("the route's envelope and the hook's are one definition", () => {
    expect(schemaOf(document, "/items", "post", "429")).toEqual(
      ref("RateLimited"),
    );
    expect(componentsOf(document).RateLimited).toEqual(routeEnvelope);
  });

  test("a field the route's definition lacks is reported by its path", () => {
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("error.retryAfter");
  });
});

describe("the documentation controller", () => {
  test("takes the format as the generator does", async () => {
    const { docs } = await import("./controller.ts");
    const { serve } = await import("@tetsujs/core/testing");

    const request = serve(
      createApp({
        routes: [
          { read: route({ method: "GET", path: "/items", handler: () => [] }) },
          docs({ info, ui: false, errors: flat }),
        ],
      }),
    );

    const document = (await (
      await request("/openapi.json")
    ).json()) as OpenApiDocument;

    expect(componentsOf(document).InternalServerError).toMatchObject({
      required: ["code", "message"],
    });
  });
});
