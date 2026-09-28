/**
 * Tests for the contract assertion: a response a test provoked, checked
 * against the operation the document describes.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { StandardSchemaV1 } from "@tetsujs/core";
import { createApp, HttpError, hook, httpError, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { documented, openapi } from "./index.ts";
import { assertDescribed } from "./testing.ts";

const described = <T>(jsonSchema: Record<string, unknown>) =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
    },
  }) as unknown as StandardSchemaV1<unknown, T>;

const envelope = (status: number, error: string) =>
  described({
    type: "object",
    required: ["status", "message", "error"],
    properties: {
      status: { type: "number", const: status },
      message: { type: "string" },
      error: { type: "string", const: error },
    },
  });

const User = described<{ id: string; name: string }>({
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "string" }, name: { type: "string" } },
});

const limited = documented(
  hook.beforeParse((ctx) => {
    if (ctx.req.headers.get("x-flood")) {
      ctx.out.headers.set("retry-after", "30");

      throw new HttpError(429, {
        status: 429,
        message: "Too Many Requests",
        error: "RATE_LIMITED",
        retryAfter: 30,
      });
    }
  }),
  {
    responses: [
      {
        status: 429,
        description: "Too many",
        error: "RATE_LIMITED",
        fields: { retryAfter: { type: "integer", minimum: 0 } },
        headers: { "retry-after": { schema: { type: "integer" } } },
      },
    ],
  },
);

const app = createApp({
  hooks: { beforeParse: [limited] },
  routes: {
    user: route({
      method: "GET",
      path: "/users/:id",
      schema: { response: { 200: User, 404: envelope(404, "NO_SUCH_USER") } },
      handler: (ctx) => {
        const mode = ctx.req.headers.get("x-mode");

        if (mode === "missing") throw httpError(404, "NO_SUCH_USER");
        if (mode === "other") throw httpError(404, "ACCOUNT_GONE");
        if (mode === "teapot") throw new HttpError(418);
        if (mode === "partial") return Response.json({ id: "1" });
        if (mode === "cached") {
          ctx.out.headers.set("x-cache", "hit");
        }

        return { id: ctx.params.id, name: "Ada" };
      },
    }),
    ping: route({
      method: "GET",
      path: "/ping",
      schema: { response: { 204: null } },
      handler: () => undefined,
    }),
    create: route({
      method: "POST",
      path: "/users",
      schema: {
        response: {
          201: {
            body: User,
            headers: described({
              type: "object",
              required: ["location"],
              properties: { location: { type: "string" } },
            }),
          },
        },
      },
      handler: (ctx) => {
        const user = { id: "7", name: "Ada" };

        if (ctx.req.headers.get("x-mode") === "forget") {
          return Response.json(user, { status: 201 });
        }

        ctx.out.status = 201;
        ctx.out.headers.set("location", "/users/7");

        return user;
      },
    }),
  },
});

const { document } = openapi(app, { info: { title: "Testing", version: "1" } });
const request = serve(app);

const as = (mode: string) =>
  request("/users/42", { headers: { "x-mode": mode } });

/** The message `assertDescribed` threw, or nothing when it passed. */
const failure = async (run: Promise<void>): Promise<string | undefined> => {
  try {
    await run;

    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("a response the document describes", () => {
  test("passes", async () => {
    expect(
      await failure(assertDescribed(document, "GET /users/42", await as("ok"))),
    ).toBeUndefined();
  });

  test("so does an envelope the route declares", async () => {
    expect(
      await failure(
        assertDescribed(document, "GET /users/42", await as("missing")),
      ),
    ).toBeUndefined();
  });

  test("so does a hook's refusal, carrying its own fields", async () => {
    const res = await request("/users/42", { headers: { "x-flood": "1" } });

    expect(
      await failure(assertDescribed(document, "GET /users/42", res)),
    ).toBeUndefined();
  });

  test("so does a response without a body", async () => {
    expect(
      await failure(
        assertDescribed(document, "GET /ping", await request("/ping")),
      ),
    ).toBeUndefined();
  });

  test("leaves the response for the test to read", async () => {
    const res = await as("ok");

    await assertDescribed(document, "GET /users/42", res);

    expect(await res.json()).toEqual({ id: "42", name: "Ada" });
  });
});

describe("a response the document does not describe", () => {
  test("a status the operation does not declare", async () => {
    const message = await failure(
      assertDescribed(document, "GET /users/42", await as("teapot")),
    );

    expect(message).toContain("GET /users/42 answered 418");
    expect(message).toContain("which the operation does not declare");
    expect(message).toContain("200, 404, 429, 500");
  });

  test("a code its status does not list", async () => {
    const message = await failure(
      assertDescribed(document, "GET /users/42", await as("other")),
    );

    expect(message).toContain(
      'error "ACCOUNT_GONE", which its 404 does not list: NO_SUCH_USER',
    );
  });

  test("a body missing a field every alternative requires", async () => {
    const message = await failure(
      assertDescribed(document, "GET /users/42", await as("partial")),
    );

    expect(message).toContain("name");
  });

  test("an operation the document does not have", async () => {
    const message = await failure(
      assertDescribed(document, "DELETE /users/42", await as("ok")),
    );

    expect(message).toContain("no operation for DELETE /users/42");
  });

  test("a header it is asked about and the status does not declare", async () => {
    const message = await failure(
      assertDescribed(document, "GET /users/42", await as("cached"), {
        headers: ["x-cache", "retry-after"],
      }),
    );

    expect(message).toContain('"x-cache"');
    expect(message).not.toContain('"retry-after"');
  });

  test("a declared header passes", async () => {
    const res = await request("/users/42", { headers: { "x-flood": "1" } });

    expect(
      await failure(
        assertDescribed(document, "GET /users/42", res, {
          headers: ["retry-after"],
        }),
      ),
    ).toBeUndefined();
  });

  test("a header its status requires and the response lacks", async () => {
    const res = await request("/users", {
      method: "POST",
      headers: { "x-mode": "forget" },
    });

    expect(
      await failure(assertDescribed(document, "POST /users", res)),
    ).toContain('no header "location", which its 201 requires');
  });

  test("a required header the response carries passes", async () => {
    const res = await request("/users", { method: "POST" });

    expect(
      await failure(assertDescribed(document, "POST /users", res)),
    ).toBeUndefined();
  });

  test("every problem is listed at once", async () => {
    const message = await failure(
      assertDescribed(document, "GET /users/42", await as("partial"), {
        headers: ["x-none"],
        validate: () => "the validator says no",
      }),
    );

    expect(message).toContain("name");
    expect(message).toContain("the validator says no");
  });
});

describe("finding the operation", () => {
  test("a literal segment wins over a parameter, as in the router", async () => {
    const both = createApp({
      // The parameter first, so that the first template to match is the
      // wrong one.
      routes: {
        one: route({
          method: "GET",
          path: "/users/:id",
          schema: { response: { 200: User } },
          handler: (ctx) => ({ id: ctx.params.id, name: "Ada" }),
        }),
        me: route({
          method: "GET",
          path: "/users/me",
          schema: { response: { 204: null } },
          handler: () => undefined,
        }),
      },
    });

    const { document: paths } = openapi(both, {
      info: { title: "Paths", version: "1" },
    });
    const call = serve(both);

    expect(
      await failure(
        assertDescribed(paths, "GET /users/me", await call("/users/me")),
      ),
    ).toBeUndefined();
  });
});

describe("a validator of your own", () => {
  test("gets the body and a schema that stands on its own", async () => {
    const seen: unknown[] = [];

    await assertDescribed(document, "GET /users/42", await as("missing"), {
      validate: (schema, body) => {
        seen.push(schema, body);

        return true;
      },
    });

    const [schema, body] = seen as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(body.error).toBe("NO_SUCH_USER");
    expect(JSON.stringify(schema)).not.toContain("#/components/schemas/");
    expect(JSON.stringify(schema)).toContain("#/$defs/");
    expect(Object.keys(schema.$defs as object)).toContain("NoSuchUser");
  });
});
