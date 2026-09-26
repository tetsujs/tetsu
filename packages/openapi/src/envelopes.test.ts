/**
 * Tests for how error envelopes are gathered into one definition per
 * status and code.
 *
 * The schemas stand in for what validators emit, taken from the real
 * ones: Zod, Valibot, ArkType and TypeBox all describe a literal as
 * `const`, Zod's one-value `z.enum` as a one-value `enum`, and Zod's
 * discriminated union as `oneOf`.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import type { OpenApiDocument } from "./document.ts";
import { documented, openapi, secured } from "./index.ts";

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

/** An envelope as Zod emits one: strict, with the code as a `const`. */
const zodEnvelope = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "object",
  properties: {
    status: { type: "number", const: status },
    message: { type: "string" },
    error: { type: "string", const: error },
    ...extra,
  },
  required: ["status", "message", "error", ...Object.keys(extra)],
  additionalProperties: false,
});

const info = { title: "Envelopes", version: "1" };

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

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const session = secured(
  hook.beforeParse(() => undefined),
  {
    name: "session",
    scheme: { type: "apiKey", in: "cookie", name: "sid" },
    error: "UNAUTHORIZED",
  },
);

describe("one definition per status and code", () => {
  test("a code the route and a hook both declare is one alternative", () => {
    const app = createApp({
      routes: {
        me: route({
          method: "GET",
          path: "/me",
          hooks: { beforeParse: [session] },
          schema: {
            response: {
              200: described({ type: "object" }),
              401: described(zodEnvelope(401, "UNAUTHORIZED")),
            },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(schemaOf(document, "/me", "get", "401")).toEqual(
      ref("Unauthorized"),
    );
  });

  test("the route's definition is the one the document keeps", () => {
    const app = createApp({
      routes: {
        me: route({
          method: "GET",
          path: "/me",
          hooks: { beforeParse: [session] },
          schema: {
            response: { 401: described(zodEnvelope(401, "UNAUTHORIZED")) },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(componentsOf(document).Unauthorized).toEqual(
      zodEnvelope(401, "UNAUTHORIZED"),
    );
  });

  test("the route's definition wins wherever the hook runs", () => {
    const app = createApp({
      hooks: { beforeParse: [session] },
      routes: {
        first: route({
          method: "GET",
          path: "/first",
          handler: () => ({}),
        }),
        second: route({
          method: "GET",
          path: "/second",
          schema: {
            response: { 401: described(zodEnvelope(401, "UNAUTHORIZED")) },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(schemaOf(document, "/first", "get", "401")).toEqual(
      ref("Unauthorized"),
    );
    expect(componentsOf(document).Unauthorized).toEqual(
      zodEnvelope(401, "UNAUTHORIZED"),
    );
  });

  test("an envelope the route declares alone is a component too", () => {
    const app = createApp({
      routes: {
        find: route({
          method: "GET",
          path: "/items/:id",
          schema: {
            response: {
              200: described({ type: "object" }),
              404: described(zodEnvelope(404, "ITEM_NOT_FOUND")),
            },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(schemaOf(document, "/items/{id}", "get", "404")).toEqual(
      ref("ItemNotFound"),
    );
    expect(schemaOf(document, "/items/{id}", "get", "200")).toEqual({
      type: "object",
    });
  });

  test("a one-value enum names the code as a const does", () => {
    const envelope = zodEnvelope(404, "ITEM_NOT_FOUND");
    const properties = envelope.properties as Record<string, unknown>;

    const app = createApp({
      routes: {
        find: route({
          method: "GET",
          path: "/items/:id",
          schema: {
            response: {
              404: described({
                ...envelope,
                properties: {
                  ...properties,
                  error: { type: "string", enum: ["ITEM_NOT_FOUND"] },
                },
              }),
            },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(schemaOf(document, "/items/{id}", "get", "404")).toEqual(
      ref("ItemNotFound"),
    );
  });

  test("a code under two statuses is two definitions", () => {
    const app = createApp({
      routes: {
        create: route({
          method: "POST",
          path: "/items",
          schema: {
            response: {
              201: described({ type: "object" }),
              400: described(zodEnvelope(400, "INVALID")),
              409: described(zodEnvelope(409, "INVALID")),
            },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(schemaOf(document, "/items", "post", "400")).toEqual(ref("Invalid"));
    expect(schemaOf(document, "/items", "post", "409")).toEqual(
      ref("Invalid409"),
    );
    expect(componentsOf(document).Invalid409).toEqual(
      zodEnvelope(409, "INVALID"),
    );
  });
});

describe("unions", () => {
  const limited = documented(
    hook.beforeParse(() => undefined),
    {
      responses: [
        { status: 429, description: "Too many", error: "RATE_LIMITED" },
      ],
    },
  );

  const withRefusals = (refusals: Record<string, unknown>) =>
    createApp({
      routes: {
        login: route({
          method: "POST",
          path: "/login",
          hooks: { beforeParse: [limited] },
          schema: {
            response: { 204: null, 429: described(refusals) },
          },
          handler: () => undefined as never,
        }),
      },
    });

  test("a union the route declares joins the status's own", () => {
    const { document } = openapi(
      withRefusals({
        anyOf: [
          zodEnvelope(429, "TOO_MANY_ATTEMPTS"),
          zodEnvelope(429, "CONTACT_LOCKED"),
        ],
      }),
      { info },
    );

    expect(schemaOf(document, "/login", "post", "429")?.anyOf).toEqual([
      ref("TooManyAttempts"),
      ref("ContactLocked"),
      ref("RateLimited"),
    ]);
  });

  test("a oneOf of distinct codes joins it too", () => {
    const { document } = openapi(
      withRefusals({
        oneOf: [
          zodEnvelope(429, "TOO_MANY_ATTEMPTS"),
          zodEnvelope(429, "CONTACT_LOCKED"),
        ],
      }),
      { info },
    );

    expect(schemaOf(document, "/login", "post", "429")?.anyOf).toEqual([
      ref("TooManyAttempts"),
      ref("ContactLocked"),
      ref("RateLimited"),
    ]);
  });

  test("a oneOf of anything else keeps its meaning", () => {
    // Exactly one of two overlapping shapes is not "either of them": a
    // body matching both is refused by the first and accepted by the
    // second, so the union stays whole.
    const overlapping = {
      oneOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    };

    const { document } = openapi(withRefusals(overlapping), { info });

    expect(schemaOf(document, "/login", "post", "429")?.anyOf).toEqual([
      overlapping,
      ref("RateLimited"),
    ]);
  });

  test("a union with more to it than its branches stays whole", () => {
    const titled = {
      title: "Refusals",
      anyOf: [
        zodEnvelope(429, "TOO_MANY_ATTEMPTS"),
        zodEnvelope(429, "CONTACT_LOCKED"),
      ],
    };

    const { document } = openapi(withRefusals(titled), { info });

    expect(schemaOf(document, "/login", "post", "429")?.anyOf).toEqual([
      titled,
      ref("RateLimited"),
    ]);
  });
});

describe("definitions that disagree", () => {
  test("a hook's fields the route's definition lacks are reported once", () => {
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

    const app = createApp({
      hooks: { beforeParse: [limited] },
      routes: {
        one: route({
          method: "GET",
          path: "/one",
          schema: {
            response: { 429: described(zodEnvelope(429, "RATE_LIMITED")) },
          },
          handler: () => ({}),
        }),
        two: route({ method: "GET", path: "/two", handler: () => ({}) }),
      },
    });

    const { warnings } = openapi(app, { info });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("RATE_LIMITED");
    expect(warnings[0]?.message).toContain("retryAfter");
  });

  test("a definition that requires other fields is reported", () => {
    const lenient = {
      ...zodEnvelope(401, "UNAUTHORIZED"),
      required: ["status", "error"],
    };

    const app = createApp({
      hooks: { beforeParse: [session] },
      routes: {
        me: route({
          method: "GET",
          path: "/me",
          schema: { response: { 401: described(lenient) } },
          handler: () => ({}),
        }),
      },
    });

    const { warnings } = openapi(app, { info });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("required");
  });

  test("definitions that differ only in wording are one", () => {
    const app = createApp({
      hooks: { beforeParse: [session] },
      routes: {
        me: route({
          method: "GET",
          path: "/me",
          schema: {
            response: { 401: described(zodEnvelope(401, "UNAUTHORIZED")) },
          },
          handler: () => ({}),
        }),
      },
    });

    expect(openapi(app, { info }).warnings).toEqual([]);
  });
});

describe("a status clients can branch on", () => {
  const limited = documented(
    hook.beforeParse(() => undefined),
    {
      responses: [
        { status: 429, description: "Too many", error: "RATE_LIMITED" },
      ],
    },
  );

  const login = (refusals: Record<string, unknown>, hooked = true) =>
    openapi(
      createApp({
        routes: {
          login: route({
            method: "POST",
            path: "/login",
            hooks: { beforeParse: hooked ? [limited] : [] },
            schema: { response: { 204: null, 429: described(refusals) } },
            handler: () => undefined as never,
          }),
        },
      }),
      { info },
    ).document;

  test("envelopes under one status are discriminated by their code", () => {
    const document = login(zodEnvelope(429, "TOO_MANY_ATTEMPTS"));

    expect(schemaOf(document, "/login", "post", "429")).toEqual({
      anyOf: [ref("TooManyAttempts"), ref("RateLimited")],
      discriminator: {
        propertyName: "error",
        mapping: {
          TOO_MANY_ATTEMPTS: "#/components/schemas/TooManyAttempts",
          RATE_LIMITED: "#/components/schemas/RateLimited",
        },
      },
    });
  });

  test("so are the envelopes of a union the route declares alone", () => {
    const document = login(
      {
        anyOf: [
          zodEnvelope(429, "TOO_MANY_ATTEMPTS"),
          zodEnvelope(429, "CONTACT_LOCKED"),
        ],
      },
      false,
    );

    expect(
      schemaOf(document, "/login", "post", "429")?.discriminator,
    ).toMatchObject({
      mapping: {
        TOO_MANY_ATTEMPTS: "#/components/schemas/TooManyAttempts",
        CONTACT_LOCKED: "#/components/schemas/ContactLocked",
      },
    });
  });

  test("a branch without a code leaves the status undiscriminated", () => {
    const document = login({ type: "object", required: ["wait"] });

    expect(schemaOf(document, "/login", "post", "429")).toEqual({
      anyOf: [{ type: "object", required: ["wait"] }, ref("RateLimited")],
    });
  });

  test("an envelope whose code the hook did not declare has none", () => {
    const guard = secured(
      hook.beforeParse(() => undefined),
      { name: "key", scheme: { type: "apiKey", in: "header", name: "x-key" } },
    );

    const { document } = openapi(
      createApp({
        routes: {
          me: route({
            method: "GET",
            path: "/me",
            hooks: { beforeParse: [session, guard] },
            handler: () => ({}),
          }),
        },
      }),
      { info },
    );

    expect(schemaOf(document, "/me", "get", "401")).toEqual({
      anyOf: [ref("Unauthorized"), ref("Failure401")],
    });
  });

  test("a single envelope is referenced as it is", () => {
    const document = login(zodEnvelope(429, "RATE_LIMITED"));

    expect(schemaOf(document, "/login", "post", "429")).toEqual(
      ref("RateLimited"),
    );
  });
});
