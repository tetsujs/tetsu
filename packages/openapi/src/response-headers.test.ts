/**
 * Tests for the headers and cookies a route's response map declares.
 *
 * A status of the map can say more than its body — `{ body, headers,
 * cookies }` — and the document says it too: each header its schema names,
 * required as the schema says, and the cookies as the `set-cookie` header
 * that sets them, OpenAPI having no object of its own for those.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import type { OpenApiDocument } from "./document.ts";
import { documented, openapi } from "./index.ts";

const described = (jsonSchema: Record<string, unknown>): StandardSchemaV1 =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1;

const Order = described({
  type: "object",
  properties: { id: { type: "integer" } },
  required: ["id"],
});

const Created = described({
  type: "object",
  properties: {
    location: { type: "string", description: "Where the new order is" },
    etag: { type: "string" },
  },
  required: ["location"],
});

const SeeOther = described({
  type: "object",
  properties: { location: { type: "string" } },
  required: ["location"],
});

const Session = described({
  type: "object",
  properties: {
    session: { type: "string", description: "The signed session token" },
    theme: { type: "string" },
  },
  required: ["session"],
});

const TooMany = described({
  type: "object",
  properties: {
    "retry-after": { type: "integer", description: "The route's" },
  },
  required: ["retry-after"],
});

const limited = documented(
  hook.beforeParse(() => undefined),
  {
    responses: [
      {
        status: 429,
        error: "RATE_LIMITED",
        description: "Too many requests",
        headers: {
          "retry-after": {
            description: "The hook's",
            schema: { type: "integer" },
          },
        },
      },
    ],
  },
);

const app = createApp({
  routes: {
    create: route({
      method: "POST",
      path: "/orders",
      schema: { response: { 201: { body: Order, headers: Created } } },
      handler: (ctx) => {
        ctx.out.status = 201;

        return { id: 1 };
      },
    }),
    redirect: route({
      method: "POST",
      path: "/redirect",
      schema: { response: { 303: { headers: SeeOther } } },
      handler: (ctx) => {
        ctx.out.status = 303;
      },
    }),
    signIn: route({
      method: "POST",
      path: "/session",
      schema: { response: { 204: { cookies: Session } } },
      handler: () => undefined,
    }),
    limited: route({
      method: "GET",
      path: "/limited",
      hooks: { beforeParse: [limited] },
      schema: {
        response: { 200: Order, 429: { body: null, headers: TooMany } },
      },
      handler: () => ({ id: 1 }),
    }),
    bare: route({ method: "GET", path: "/bare", handler: () => "ok" }),
  },
});

const { document } = openapi(app, { info: { title: "Headers", version: "1" } });

const responsesOf = (
  doc: OpenApiDocument,
  path: string,
  method: string,
): Record<string, Record<string, unknown>> =>
  (doc.paths[path]?.[method]?.responses ?? {}) as unknown as Record<
    string,
    Record<string, unknown>
  >;

describe("the headers a status declares", () => {
  test("are its headers, required as the schema says, described by their property", () => {
    const created = responsesOf(document, "/orders", "post")["201"];

    expect(created?.headers).toEqual({
      location: {
        description: "Where the new order is",
        required: true,
        schema: { type: "string" },
      },
      etag: { schema: { type: "string" } },
    });
    expect(created?.content).toBeDefined();
  });

  test("of a status without a body are all it says", () => {
    const responses = responsesOf(document, "/redirect", "post");

    expect(responses["303"]?.headers).toEqual({
      location: { required: true, schema: { type: "string" } },
    });
    expect(responses["303"]?.content).toBeUndefined();
  });

  test("win over a hook's header of the same name", () => {
    const tooMany = responsesOf(document, "/limited", "get")["429"];

    expect(tooMany).toMatchObject({
      headers: { "retry-after": { description: "The route's" } },
    });
  });
});

describe("the cookies a status declares", () => {
  test("are the set-cookie header, listing them", () => {
    const signedIn = responsesOf(document, "/session", "post")["204"];

    expect(signedIn?.headers).toEqual({
      "set-cookie": {
        description:
          "Sets these cookies:\n\n- `session`: The signed session token\n- `theme`",
        required: true,
        schema: { type: "string" },
      },
    });
  });
});

describe("a success nobody declared", () => {
  test("is not added to a route that declares only a redirect", () => {
    const statuses = Object.keys(responsesOf(document, "/redirect", "post"));

    expect(statuses).toContain("303");
    expect(statuses).not.toContain("200");
  });

  test("still stands for a route that declares nothing", () => {
    expect(Object.keys(responsesOf(document, "/bare", "get"))).toContain("200");
  });
});

/**
 * A schema whose input and output differ the way a `default` makes them:
 * the field is optional going in and filled coming out.
 */
const defaulted = (name: string): StandardSchemaV1 => {
  const property = { [name]: { type: "string", default: "none" } };

  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => ({ type: "object", properties: property }),
        output: () => ({
          type: "object",
          properties: property,
          required: [name],
        }),
      },
    },
  } as unknown as StandardSchemaV1;
};

describe("a header or cookie with a default", () => {
  const { document: defaults } = openapi(
    createApp({
      routes: {
        traced: route({
          method: "GET",
          path: "/traced",
          schema: {
            response: {
              200: {
                body: Order,
                headers: defaulted("x-trace"),
                cookies: defaulted("theme"),
              },
            },
          },
          handler: () => ({ id: 1 }),
        }),
      },
    }),
    { info: { title: "Defaults", version: "1" } },
  );

  const headers = responsesOf(defaults, "/traced", "get")["200"]?.headers as
    | Record<string, { required?: boolean }>
    | undefined;

  /**
   * The schema checks what the handler put on `ctx.out` and the response
   * carries that, not the schema's output: a default fills nothing in, so
   * a header the handler may leave out is not required.
   */
  test("is not required, since the response carries what the handler set", () => {
    expect(headers?.["x-trace"]?.required).toBeUndefined();
    expect(headers?.["set-cookie"]?.required).toBeUndefined();
  });
});
