/**
 * Tests for how a status is described.
 *
 * A route declares a status by its schema, and the schema can say what it
 * is — `.describe()` in Zod and ArkType, `v.description()` in Valibot,
 * `{ description }` in TypeBox. That is the route's description of the
 * status, as a hook's `documented()` description is the hook's. Several of
 * them under one status are a list, each led by its code.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import type { OpenApiDocument } from "./document.ts";
import { documented, openapi, secured } from "./index.ts";

const described = (jsonSchema: Record<string, unknown>): StandardSchemaV1 =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1;

const envelope = (status: number, error: string, description?: string) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties: {
    status: { type: "number", const: status },
    message: { type: "string" },
    error: { type: "string", const: error },
  },
  required: ["status", "message", "error"],
});

const info = { title: "Descriptions", version: "1" };

const descriptionOf = (
  document: OpenApiDocument,
  path: string,
  method: string,
  status: string,
): string | undefined =>
  document.paths[path]?.[method]?.responses[status]?.description;

const limited = documented(
  hook.beforeParse(() => undefined),
  {
    responses: [
      { status: 429, description: "Too many requests", error: "RATE_LIMITED" },
    ],
  },
);

describe("what the route's schema says", () => {
  const app = createApp({
    routes: {
      me: route({
        method: "GET",
        path: "/me",
        schema: {
          response: {
            200: described({
              type: "object",
              description: "The signed-in user.",
            }),
            404: described(
              envelope(404, "NO_SUCH_USER", "There is no such user"),
            ),
            410: described(envelope(410, "GONE")),
          },
        },
        handler: () => ({}),
      }),
    },
  });

  const { document } = openapi(app, { info });

  test("describes an error status", () => {
    expect(descriptionOf(document, "/me", "get", "404")).toBe(
      "There is no such user",
    );
  });

  test("describes a successful one just the same", () => {
    expect(descriptionOf(document, "/me", "get", "200")).toBe(
      "The signed-in user.",
    );
  });

  test("a schema that says nothing leaves the status its reason phrase", () => {
    expect(descriptionOf(document, "/me", "get", "410")).toBe("Gone");
  });

  test("the definition keeps its description", () => {
    const schemas = (document.components?.schemas ?? {}) as Record<
      string,
      { description?: string }
    >;

    expect(schemas.NoSuchUser?.description).toBe("There is no such user");
  });
});

describe("several descriptions under one status", () => {
  const app = createApp({
    routes: {
      login: route({
        method: "POST",
        path: "/session",
        hooks: { beforeParse: [limited] },
        schema: {
          response: {
            204: null,
            429: described({
              anyOf: [
                envelope(429, "TOO_MANY_ATTEMPTS", "too many wrong codes"),
                envelope(429, "CONTACT_LOCKED", "the contact is locked"),
              ],
            }),
          },
        },
        handler: () => undefined as never,
      }),
    },
  });

  const { document } = openapi(app, { info });

  test("are a list, each led by its code, the route's first", () => {
    expect(descriptionOf(document, "/session", "post", "429")).toBe(
      [
        "- `TOO_MANY_ATTEMPTS`: too many wrong codes",
        "- `CONTACT_LOCKED`: the contact is locked",
        "- `RATE_LIMITED`: Too many requests",
      ].join("\n"),
    );
  });

  test("the union still joins the status flat", () => {
    const schema = document.paths["/session"]?.post?.responses["429"]
      ?.content?.["application/json"]?.schema as { anyOf?: unknown[] };

    expect(schema.anyOf).toHaveLength(3);
  });
});

describe("a union described as a whole", () => {
  test("is one description, and its branches still join the status", () => {
    const app = createApp({
      routes: {
        login: route({
          method: "POST",
          path: "/session",
          schema: {
            response: {
              204: null,
              403: described({
                description: "the session cannot be opened",
                anyOf: [
                  envelope(403, "ACCOUNT_DISABLED"),
                  envelope(403, "CONTACT_LOCKED"),
                ],
              }),
            },
          },
          handler: () => undefined as never,
        }),
      },
    });

    const { document } = openapi(app, { info });
    const response = document.paths["/session"]?.post?.responses["403"];

    expect(response?.description).toBe("the session cannot be opened");
    const schema = (response?.content?.["application/json"]?.schema ?? {}) as {
      anyOf?: unknown[];
    };

    expect(schema.anyOf).toEqual([
      { $ref: "#/components/schemas/AccountDisabled" },
      { $ref: "#/components/schemas/ContactLocked" },
    ]);
  });
});

describe("the same description twice", () => {
  test("is said once", () => {
    const guard = secured(
      hook.beforeParse(() => undefined),
      {
        name: "session",
        scheme: { type: "apiKey", in: "cookie", name: "sid" },
        error: "UNAUTHORIZED",
        description: "no session",
      },
    );

    const app = createApp({
      routes: {
        me: route({
          method: "GET",
          path: "/me",
          hooks: { beforeParse: [guard] },
          schema: {
            response: {
              200: described({ type: "object" }),
              401: described(envelope(401, "UNAUTHORIZED", "no session")),
            },
          },
          handler: () => ({}),
        }),
      },
    });

    const { document } = openapi(app, { info });

    expect(descriptionOf(document, "/me", "get", "401")).toBe("no session");
  });
});

describe("an error format of the application's own", () => {
  test("leads each description with the code as the format reads it", () => {
    const flat = (error: string, description: string) => ({
      type: "object",
      description,
      required: ["code", "message"],
      properties: {
        code: { type: "string", const: error },
        message: { type: "string" },
      },
    });

    const app = createApp({
      routes: {
        login: route({
          method: "POST",
          path: "/session",
          schema: {
            response: {
              204: null,
              403: described({
                anyOf: [
                  flat("ACCOUNT_DISABLED", "this account is disabled"),
                  flat("CAPTCHA_FAILED", "the captcha did not pass"),
                ],
              }),
            },
          },
          handler: () => undefined as never,
        }),
      },
    });

    const { document } = openapi(app, {
      info,
      errors: {
        schema: ({ error }) => ({
          type: "object",
          properties: { code: { const: error } },
        }),
        discriminator: "code",
      },
    });

    expect(descriptionOf(document, "/session", "post", "403")).toBe(
      [
        "- `ACCOUNT_DISABLED`: this account is disabled",
        "- `CAPTCHA_FAILED`: the captcha did not pass",
      ].join("\n"),
    );
  });
});
