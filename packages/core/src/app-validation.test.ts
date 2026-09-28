/**
 * Integration tests: schema validation through a live server.
 *
 * Multi-part issue aggregation, header validation, response validation
 * (the strip barrier and its default), reshaping validation failures in
 * `onError`, and the request body size limit.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { HttpError, ValidationError } from "./error.ts";
import { hook } from "./hook.ts";
import type { FailureReport } from "./report.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

const IdParams: StandardSchemaV1<unknown, { id: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const raw = (value as { id?: unknown }).id;
      const id = Number(raw);

      return Number.isInteger(id)
        ? { value: { id } }
        : { issues: [{ message: "id must be an integer", path: ["id"] }] };
    },
  },
};

const TagsQuery: StandardSchemaV1<unknown, { tag: string[] }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const tag = (value as { tag?: unknown }).tag;

      if (typeof tag === "string") {
        return { value: { tag: [tag] } };
      }

      if (Array.isArray(tag)) {
        return { value: { tag: tag as string[] } };
      }

      return { issues: [{ message: "tag is required", path: ["tag"] }] };
    },
  },
};

describe("validation coverage", () => {
  const Tenant: StandardSchemaV1<unknown, { "x-tenant": string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const tenant = (value as Record<string, unknown>)["x-tenant"];

        return typeof tenant === "string"
          ? { value: { "x-tenant": tenant } }
          : {
              issues: [{ message: "x-tenant is required", path: ["x-tenant"] }],
            };
      },
    },
  };

  const Nested: StandardSchemaV1<unknown, { items: { name: string }[] }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => ({
        issues: [
          {
            message: "name must be a string",
            path: [{ key: "items" }, { key: 0 }, { key: "name" }],
          },
        ],
      }),
    },
  };

  class MixedController {
    headers = route({
      method: "GET",
      path: "/tenanted",
      schema: { headers: Tenant },
      handler: (ctx) => ({ tenant: ctx.headers["x-tenant"] }),
    });

    everything = route({
      method: "POST",
      path: "/everything/:id",
      schema: { params: IdParams, query: TagsQuery, body: Nested },
      handler: () => ({ ok: true }),
    });
  }

  const mixedRequest = serve(createApp({ routes: new MixedController() }));

  test("validates headers, lowercased", async () => {
    const ok = await mixedRequest("/tenanted", {
      headers: { "X-Tenant": "acme" },
    });
    const missing = await mixedRequest("/tenanted");

    expect(await ok.json()).toEqual({ tenant: "acme" });
    expect(missing.status).toBe(422);
  });

  test("aggregates issues from every request part in one response", async () => {
    const res = await mixedRequest("/everything/abc", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as {
      issues: { path: (string | number)[] }[];
    };

    expect(res.status).toBe(422);
    expect(body.issues.map((issue) => issue.path[0])).toEqual([
      "params",
      "query",
      "body",
    ]);
  });

  test("flattens object-shaped issue paths to plain keys", async () => {
    const res = await mixedRequest("/everything/1?tag=a", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as {
      issues: { path: (string | number)[] }[];
    };

    expect(body.issues[0]?.path).toEqual(["body", "items", 0, "name"]);
  });

  test("the rejection status is configurable", async () => {
    const strictRequest = serve(
      createApp({
        routes: new MixedController(),
        validation: { status: 400 },
      }),
    );

    const res = await strictRequest("/tenanted");

    expect(res.status).toBe(400);
  });
});

describe("a refusal without issues", () => {
  const refuse = (value: unknown) =>
    (value as { role?: unknown }).role === "user"
      ? { value: value as { role: string } }
      : { issues: [] };

  const Refusing: StandardSchemaV1<unknown, { role: string }> = {
    "~standard": { version: 1, vendor: "test", validate: refuse },
  };

  const RefusingLater: StandardSchemaV1<unknown, { role: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) => refuse(value),
    },
  };

  const request = serve(
    createApp({
      routes: {
        sync: route({
          method: "POST",
          path: "/sync",
          schema: { body: Refusing },
          handler: (ctx) => ctx.body,
        }),
        async: route({
          method: "POST",
          path: "/async",
          schema: { body: RefusingLater },
          handler: (ctx) => ctx.body,
        }),
        query: route({
          method: "GET",
          path: "/query",
          schema: { query: Refusing },
          handler: (ctx) => ctx.query,
        }),
      },
    }),
  );

  test.each([
    ["a body", "/sync", "body"],
    ["a body checked asynchronously", "/async", "body"],
    ["a query", "/query?role=admin", "query"],
  ])("is still a refusal, for %s", async (_, path, part) => {
    const res = await request(
      path,
      part === "body"
        ? { method: "POST", body: JSON.stringify({ role: "admin" }) }
        : {},
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      issues: [{ message: "Invalid value", path: [part] }],
    });
  });
});

describe("schema precedence over hook contributions", () => {
  const Quantity: StandardSchemaV1<unknown, { qty: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({
        value: { qty: Number((value as { qty?: unknown }).qty) },
      }),
    },
  };

  const normalizeBody = hook.beforeValidation(() => ({
    body: { qty: "7" },
  }));

  const normalizeQuery = hook.beforeParse(() => ({
    query: { page: "from-hook" },
  }));

  class PrecedenceController {
    declared = route({
      method: "POST",
      path: "/declared",
      schema: { body: Quantity },
      hooks: {
        beforeParse: [normalizeQuery],
        beforeValidation: [normalizeBody],
      },
      handler: (ctx) => ({ body: ctx.body, query: ctx.query }),
    });

    undeclared = route({
      method: "POST",
      path: "/undeclared",
      hooks: {
        beforeParse: [normalizeQuery],
        beforeValidation: [normalizeBody],
      },
      handler: (ctx) => ({ body: ctx.body, query: ctx.query }),
    });
  }

  const Page: StandardSchemaV1<unknown, { page: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({
        value: { page: Number((value as { page?: unknown }).page) },
      }),
    },
  };

  const Tenant: StandardSchemaV1<unknown, { tenant: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({
        value: { tenant: String((value as { tenant?: unknown }).tenant) },
      }),
    },
  };

  const rewriteQuery = hook.beforeParse(() => ({ query: { page: "7" } }));

  const rewriteHeaders = hook.beforeParse(() => ({
    headers: { tenant: "from-hook" },
  }));

  class NormalizationController {
    query = route({
      method: "GET",
      path: "/declared-query",
      schema: { query: Page },
      hooks: { beforeParse: [rewriteQuery] },
      handler: (ctx) => ({ query: ctx.query }),
    });

    rawQuery = route({
      method: "GET",
      path: "/raw-query",
      schema: { query: Page },
      handler: (ctx) => ({ query: ctx.query }),
    });

    headers = route({
      method: "GET",
      path: "/declared-headers",
      schema: { headers: Tenant },
      hooks: { beforeParse: [rewriteHeaders] },
      handler: (ctx) => ({ headers: ctx.headers }),
    });

    rawHeaders = route({
      method: "GET",
      path: "/raw-headers",
      schema: { headers: Tenant },
      handler: (ctx) => ({ headers: ctx.headers }),
    });
  }

  const normalizationRequest = serve(
    createApp({ routes: new NormalizationController() }),
  );

  const request = serve(createApp({ routes: new PrecedenceController() }));

  test("validation overwrites what a pre-validation hook contributed", async () => {
    const res = await request("/declared?page=2", {
      method: "POST",
      body: JSON.stringify({ qty: "ignored" }),
    });

    expect(await res.json()).toEqual({
      body: { qty: 7 },
      query: { page: "from-hook" },
    });
  });

  test("a declared query is validated from the hook's value", async () => {
    const res = await normalizationRequest("/declared-query?page=1");

    expect(await res.json()).toEqual({ query: { page: 7 } });
  });

  test("a declared query falls back to the raw request", async () => {
    const res = await normalizationRequest("/raw-query?page=1");

    expect(await res.json()).toEqual({ query: { page: 1 } });
  });

  test("declared headers are validated from the hook's value", async () => {
    const res = await normalizationRequest("/declared-headers", {
      headers: { tenant: "from-request" },
    });

    expect(await res.json()).toEqual({ headers: { tenant: "from-hook" } });
  });

  test("declared headers fall back to the raw request", async () => {
    const res = await normalizationRequest("/raw-headers", {
      headers: { tenant: "from-request" },
    });

    expect(await res.json()).toEqual({ headers: { tenant: "from-request" } });
  });

  test("a part without a schema keeps the hook's contribution", async () => {
    const res = await request("/undeclared?page=2", {
      method: "POST",
      body: JSON.stringify({ qty: "ignored" }),
    });

    expect(await res.json()).toEqual({
      body: { qty: "7" },
      query: { page: "from-hook" },
    });
  });
});

describe("response validation", () => {
  const errors = captureErrors();

  const PublicUser: StandardSchemaV1<unknown, { id: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const id = (value as { id?: unknown }).id;

        return typeof id === "string"
          ? { value: { id } }
          : { issues: [{ message: "id must be a string", path: ["id"] }] };
      },
    },
  };

  class LeakyController {
    get = route({
      method: "GET",
      path: "/user",
      schema: { response: PublicUser },
      handler: () =>
        ({ id: "u1", passwordHash: "secret" }) as unknown as { id: string },
    });

    broken = route({
      method: "GET",
      path: "/broken",
      schema: { response: PublicUser },
      handler: () => ({ id: 42 }) as unknown as { id: string },
    });

    raw = route({
      method: "GET",
      path: "/raw-response",
      schema: { response: PublicUser },
      handler: () => Response.json({ id: "u1", extra: true }),
    });
  }

  const defaultRequest = serve(createApp({ routes: new LeakyController() }));

  const strictRequest = serve(
    createApp({ routes: new LeakyController(), validateResponses: true }),
  );

  const looseRequest = serve(
    createApp({ routes: new LeakyController(), validateResponses: false }),
  );

  test("the default strips fields the response schema does not declare", async () => {
    const res = await defaultRequest("/user");

    expect(await res.json()).toEqual({ id: "u1" });
  });

  test("a handler breaking its own contract is a 500, not a leak", async () => {
    const res = await strictRequest("/broken");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
      error: "INTERNAL_SERVER_ERROR",
    });
    expect(errors.lines.join("\n")).toContain(
      "Handler result does not match its response schema",
    );
  });

  test("a raw Response is passed through unchecked", async () => {
    const res = await defaultRequest("/raw-response");

    expect(await res.json()).toEqual({ id: "u1", extra: true });
  });

  test("false disables the runtime check entirely", async () => {
    const res = await looseRequest("/user");

    expect(await res.json()).toEqual({ id: "u1", passwordHash: "secret" });
  });
});

describe("response schemas by status", () => {
  const errors = captureErrors();

  const Session: StandardSchemaV1<unknown, { token: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const token = (value as { token?: unknown }).token;

        return typeof token === "string"
          ? { value: { token } }
          : {
              issues: [{ message: "token must be a string", path: ["token"] }],
            };
      },
    },
  };

  const Created: StandardSchemaV1<unknown, { id: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const id = (value as { id?: unknown }).id;

        return typeof id === "number"
          ? { value: { id } }
          : { issues: [{ message: "id must be a number", path: ["id"] }] };
      },
    },
  };

  const Refused: StandardSchemaV1<unknown, { code: "auth_code_invalid" }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const code = (value as { code?: unknown }).code;

        return code === "auth_code_invalid"
          ? { value: { code } }
          : { issues: [{ message: "unknown code", path: ["code"] }] };
      },
    },
  };

  class SessionController {
    create = route({
      method: "POST",
      path: "/session/:mode",
      schema: { response: { 200: Session, 201: Created, 422: Refused } },
      handler: (ctx) => {
        if (ctx.params.mode === "created") {
          ctx.out.status = 201;

          return { id: 7 };
        }

        if (ctx.params.mode === "refused") {
          ctx.out.status = 422;

          return { code: "auth_code_invalid" as const };
        }

        if (ctx.params.mode === "mismatched") {
          return { id: 7 };
        }

        return { token: "t1" };
      },
    });

    revoke = route({
      method: "DELETE",
      path: "/session",
      schema: { response: { 204: null } },
      handler: (ctx) => {
        ctx.out.headers.set("x-revoked", "1");

        return undefined;
      },
    });

    maybeRevoke = route({
      method: "DELETE",
      path: "/session/maybe",
      schema: { response: { 200: Session, 204: null } },
      handler: (ctx) =>
        ctx.req.headers.has("x-keep") ? { token: "kept" } : undefined,
    });

    accepted = route({
      method: "POST",
      path: "/session/accepted",
      schema: { response: { 202: null, 204: null } },
      handler: (ctx) => {
        ctx.out.status = 202;

        return undefined;
      },
    });

    hooked = route({
      method: "POST",
      path: "/session/hooked",
      schema: { response: { 200: Session } },
      hooks: {
        beforeHandle: [
          hook.beforeHandle((ctx) => {
            ctx.out.status = 202;
          }),
        ],
      },
      handler: () => ({ token: "t" }),
    });

    forgotten = route({
      method: "POST",
      path: "/session/forgotten",
      schema: { response: { 201: Created } },
      handler: () => ({ id: 7 }),
    });

    raw = route({
      method: "POST",
      path: "/session/raw",
      schema: { response: { 200: Session } },
      handler: () => new Response(null, { status: 418 }),
    });

    thrown = route({
      method: "POST",
      path: "/session/error/thrown",
      schema: { response: { 200: Session, 422: Refused } },
      handler: () => {
        throw new HttpError(422, { code: "not_in_the_schema" });
      },
    });
  }

  const request = serve(createApp({ routes: new SessionController() }));

  const trusting = serve(
    createApp({ routes: new SessionController(), validateResponses: false }),
  );

  test("a status declared as null answers with no body at all", async () => {
    const res = await request("/session", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(res.headers.get("x-revoked")).toBe("1");
    expect(await res.text()).toBe("");
  });

  test("an implicit 204 is checked by the 204 entry, not the 200 one", async () => {
    const res = await request("/session/maybe", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(errors.lines).toEqual([]);
  });

  test("a status the handler set wins over the implicit 204", async () => {
    const res = await request("/session/accepted", { method: "POST" });

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(errors.lines).toEqual([]);
  });

  test("the same route still answers under its 200 entry", async () => {
    const res = await request("/session/maybe", {
      method: "DELETE",
      headers: { "x-keep": "1" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "kept" });
  });

  test("the entry matching the outgoing status does the checking", async () => {
    const ok = await request("/session/plain", { method: "POST" });
    const created = await request("/session/created", { method: "POST" });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ token: "t1" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 7 });
  });

  test("a returned error shape is checked by its own entry", async () => {
    const res = await request("/session/refused", { method: "POST" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "auth_code_invalid" });
  });

  test("a shape returned under the wrong status is a contract violation", async () => {
    const res = await request("/session/mismatched", { method: "POST" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
      error: "INTERNAL_SERVER_ERROR",
    });
  });

  test("a status the map does not declare is refused, whoever set it", async () => {
    const res = await request("/session/hooked", { method: "POST" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
      error: "INTERNAL_SERVER_ERROR",
    });
    expect(errors.lines.join("\n")).toContain(
      "Handler answered 202, which its response map does not declare (200)",
    );
  });

  test("an implicit 200 the map does not declare is refused", async () => {
    const res = await request("/session/forgotten", { method: "POST" });

    expect(res.status).toBe(500);
    expect(errors.lines.join("\n")).toContain(
      "Handler answered 200, which its response map does not declare (201)",
    );
  });

  test("a Response the handler built states its own status, unchecked", async () => {
    const res = await request("/session/raw", { method: "POST" });

    expect(res.status).toBe(418);
    expect(errors.lines).toEqual([]);
  });

  test("validateResponses: false leaves the status unchecked too", async () => {
    const res = await trusting("/session/hooked", { method: "POST" });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ token: "t" });
    expect(errors.lines).toEqual([]);
  });

  test("a thrown error is documentation only, never checked", async () => {
    const res = await request("/session/error/thrown", { method: "POST" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "not_in_the_schema" });
  });

  test("a single schema still checks every status", async () => {
    class LooseController {
      any = route({
        method: "POST",
        path: "/single/:mode",
        schema: { response: Session },
        handler: (ctx) => {
          ctx.out.status = ctx.params.mode === "created" ? 201 : 200;

          return { token: "t1", leaked: true } as unknown as { token: string };
        },
      });
    }

    const single = serve(createApp({ routes: new LooseController() }));

    const ok = await single("/single/plain", { method: "POST" });
    const created = await single("/single/created", { method: "POST" });

    expect(await ok.json()).toEqual({ token: "t1" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ token: "t1" });
  });
});

describe("validation error interception", () => {
  test("an onError hook can reshape validation failures via instanceof", async () => {
    const asProblemDetails = hook.onError((ctx) =>
      ctx.error instanceof ValidationError
        ? Response.json(
            {
              title: "Validation failed",
              errors: ctx.error.issues.map((issue) => ({
                pointer: `/${issue.path.join("/")}`,
              })),
            },
            {
              status: ctx.error.status,
              headers: { "content-type": "application/problem+json" },
            },
          )
        : undefined,
    );

    class StrictController {
      get = route({
        method: "GET",
        path: "/strict/:id",
        schema: { params: IdParams },
        handler: (ctx) => ({ id: ctx.params.id }),
      });
    }

    const strictAppRequest = serve(
      createApp({
        hooks: { onError: [asProblemDetails] },
        routes: new StrictController(),
      }),
    );

    const rejected = await strictAppRequest("/strict/abc");
    const accepted = await strictAppRequest("/strict/7");

    expect(rejected.status).toBe(422);
    expect(rejected.headers.get("content-type")).toContain("problem+json");
    expect(await rejected.json()).toEqual({
      title: "Validation failed",
      errors: [{ pointer: "/params/id" }],
    });

    expect(await accepted.json()).toEqual({ id: 7 });
  });

  test("leaves other errors to the default mapper", async () => {
    const onlyValidation = hook.onError((ctx) =>
      ctx.error instanceof ValidationError
        ? Response.json({ handled: true }, { status: 400 })
        : undefined,
    );

    class MixedController {
      boom = route({
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new HttpError(418, { code: "teapot" });
        },
      });
    }

    const mixedAppRequest = serve(
      createApp({
        hooks: { onError: [onlyValidation] },
        routes: new MixedController(),
      }),
    );

    const res = await mixedAppRequest("/boom");

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ code: "teapot" });
  });
});

describe("request body size limit", () => {
  const AnyBody: StandardSchemaV1<unknown, Record<string, unknown>> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as Record<string, unknown> }),
    },
  };

  class BodyController {
    echo = route({
      method: "POST",
      path: "/echo",
      schema: { body: AnyBody },
      handler: (ctx) => ({ keys: Object.keys(ctx.body) }),
    });

    schemaless = route({
      method: "POST",
      path: "/schemaless",
      handler: () => ({ ok: true }),
    });
  }

  const limitedRequest = serve(
    createApp({ routes: new BodyController(), maxBodySize: 1024 }),
  );

  /**
   * A fresh server for a test that aborts a chunked body mid-stream:
   * cutting the stream leaves the connection's framing broken, so the next
   * request over the same socket fails. Isolating the abort keeps that
   * damage out of unrelated tests.
   */
  const ownServer = () =>
    serve(createApp({ routes: new BodyController(), maxBodySize: 1024 }));

  test("a body over the limit is a 413 before parsing and validation", async () => {
    const res = await limitedRequest("/echo", {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(2048) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });
  });

  test("a body under the limit passes untouched", async () => {
    const res = await limitedRequest("/echo", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: ["a"] });
  });

  test("a chunked body is dropped as soon as it crosses the limit", async () => {
    const chunk = new TextEncoder().encode("x".repeat(512));

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await ownServer()("/echo", { method: "POST", body });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });
  });

  describe("at the boundary", () => {
    const boundaryRequest = serve(
      createApp({ routes: new BodyController(), maxBodySize: 1024 }),
    );

    const envelope = JSON.stringify({ pad: "" }).length;

    const bodyOf = (size: number) =>
      JSON.stringify({ pad: "x".repeat(size - envelope) });

    const streamOf = (size: number) => {
      const body = bodyOf(size);
      const half = Math.floor(body.length / 2);
      const encoder = new TextEncoder();

      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body.slice(0, half)));
          controller.enqueue(encoder.encode(body.slice(half)));
          controller.close();
        },
      });
    };

    test("a declared body of exactly the limit passes", async () => {
      const body = bodyOf(1024);

      expect(body.length).toBe(1024);

      const res = await boundaryRequest("/echo", { method: "POST", body });

      expect(res.status).toBe(200);
    });

    test("a declared body one byte over the limit is a 413", async () => {
      const res = await boundaryRequest("/echo", {
        method: "POST",
        body: bodyOf(1025),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        status: 413,
        message: "Body exceeds the configured limit",
        error: "BODY_TOO_LARGE",
      });
    });

    test("a chunked body of exactly the limit passes", async () => {
      const res = await boundaryRequest("/echo", {
        method: "POST",
        body: streamOf(1024),
      });

      expect(res.status).toBe(200);
    });

    test("a chunked body one byte over the limit is a 413", async () => {
      const res = await ownServer()("/echo", {
        method: "POST",
        body: streamOf(1025),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        status: 413,
        message: "Body exceeds the configured limit",
        error: "BODY_TOO_LARGE",
      });
    });
  });

  test("a route without a body schema never reads the body, so no 413", async () => {
    const res = await limitedRequest("/schemaless", {
      method: "POST",
      body: "x".repeat(4096),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("the default limit is 1 MiB", async () => {
    const defaultRequest = serve(createApp({ routes: new BodyController() }));

    const res = await defaultRequest("/echo", {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(1_100_000) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });
  });
});

describe("response headers and cookies", () => {
  const seen: Record<string, unknown>[] = [];

  /**
   * Requires the named keys to be strings, records what it was given, and
   * passes the rest through, as an object schema does by default.
   */
  const requiring = (...names: string[]): StandardSchemaV1 => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        seen.push({ ...(value as Record<string, unknown>) });

        const missing = names.filter(
          (name) =>
            typeof (value as Record<string, unknown>)[name] !== "string",
        );

        return missing.length === 0
          ? { value }
          : {
              issues: missing.map((name) => ({
                message: `${name} is required`,
                path: [name],
              })),
            };
      },
    },
  });

  const later = (schema: StandardSchemaV1): StandardSchemaV1 => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) => schema["~standard"].validate(value),
    },
  });

  const Order: StandardSchemaV1<unknown, { id: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as { id: number } }),
    },
  };

  const reports: FailureReport<object>[] = [];

  const stamp = hook.beforeParse((ctx) => {
    ctx.out.headers.set("x-request-id", "req-1");
  });

  const app = (validateResponses: boolean) =>
    createApp({
      cookies: { secret: "top-secret", sign: ["session"] },
      hooks: { beforeParse: [stamp] },
      reportError: (report) => reports.push(report),
      validateResponses,
      routes: {
        created: route({
          method: "POST",
          path: "/orders",
          schema: {
            response: { 201: { body: Order, headers: requiring("location") } },
          },
          handler: (ctx) => {
            ctx.out.status = 201;
            ctx.out.headers.set("location", "/orders/1");
            ctx.out.cookies.set("cart", "");

            return { id: 1 };
          },
        }),
        forgot: route({
          method: "POST",
          path: "/forgot",
          schema: {
            response: { 201: { body: Order, headers: requiring("location") } },
          },
          handler: (ctx) => {
            ctx.out.status = 201;

            return { id: 1 };
          },
        }),
        later: route({
          method: "POST",
          path: "/later",
          schema: {
            response: {
              201: { body: Order, headers: later(requiring("location")) },
            },
          },
          handler: (ctx) => {
            ctx.out.status = 201;

            return { id: 1 };
          },
        }),
        redirect: route({
          method: "POST",
          path: "/redirect",
          schema: { response: { 303: { headers: requiring("location") } } },
          handler: (ctx) => {
            ctx.out.status = 303;
            ctx.out.headers.set("location", "/orders");
          },
        }),
        signIn: route({
          method: "POST",
          path: "/sign-in",
          schema: {
            response: { 204: { cookies: requiring("session", "theme") } },
          },
          handler: (ctx) => {
            ctx.out.cookies.set("session", "user-1");
            ctx.out.cookies.set("theme", "dark mode");
          },
        }),
        signOut: route({
          method: "POST",
          path: "/sign-out",
          schema: { response: { 204: { cookies: requiring("session") } } },
          handler: (ctx) => {
            ctx.out.cookies.delete("session");
          },
        }),
        native: route({
          method: "POST",
          path: "/native",
          schema: { response: { 204: { cookies: requiring("session") } } },
          handler: (ctx) => {
            ctx.req.cookies?.set("session", "through-bun");
          },
        }),
        expired: route({
          method: "POST",
          path: "/expired",
          schema: { response: { 204: { cookies: requiring("session") } } },
          handler: (ctx) => {
            ctx.out.cookies.set("session", "gone", { maxAge: 0 });
          },
        }),
        noSession: route({
          method: "POST",
          path: "/no-session",
          schema: { response: { 204: { cookies: requiring("session") } } },
          handler: () => undefined,
        }),
        built: route({
          method: "POST",
          path: "/built",
          schema: {
            response: { 201: { body: Order, headers: requiring("location") } },
          },
          handler: () => Response.json({ id: 1 }, { status: 201 }),
        }),
      },
    });

  const request = serve(app(true));
  const unchecked = serve(app(false));

  const post = async (path: string, via = request) => {
    seen.length = 0;
    reports.length = 0;

    return via(path, { method: "POST", redirect: "manual" });
  };

  test("a declared header the response carries passes, with the body", async () => {
    const res = await post("/orders");

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/orders/1");
    expect(await res.json()).toEqual({ id: 1 });
  });

  test("the schema sees every header on ctx.out, a hook's included, and no set-cookie", async () => {
    await post("/orders");

    expect(seen).toEqual([{ "x-request-id": "req-1", location: "/orders/1" }]);
  });

  test.each([
    ["checked at once", "/forgot"],
    ["checked asynchronously", "/later"],
  ])("a missing header is a broken contract, %s", async (_, path) => {
    const res = await post(path);

    expect(res.status).toBe(500);
    expect(reports.map((report) => report.source)).toEqual(["response"]);
    expect((reports[0]?.error as Error | undefined)?.message).toBe(
      "Handler's response headers do not match their schema",
    );
  });

  test("an entry without a body is a status that carries none", async () => {
    const res = await post("/redirect");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/orders");
    expect(await res.text()).toBe("");
  });

  test("the cookies schema sees each value as the handler wrote it", async () => {
    const res = await post("/sign-in");

    expect(res.status).toBe(204);
    expect(seen).toEqual([{ session: "user-1", theme: "dark mode" }]);
  });

  test("a deleted cookie is set to nothing", async () => {
    await post("/sign-out");

    expect(seen).toEqual([{ session: "" }]);
  });

  test("a cookie set through Bun's own req.cookies counts", async () => {
    const res = await post("/native");

    expect(res.status).toBe(204);
    expect(seen).toEqual([{ session: "through-bun" }]);
  });

  test("a cookie set to expire at once is set to nothing", async () => {
    await post("/expired");

    expect(seen).toEqual([{ session: "" }]);
  });

  test("an entry with a part that is none of body, headers and cookies is refused", () => {
    expect(() =>
      route({
        method: "GET",
        path: "/typo",
        schema: {
          response: {
            200: { body: Order, header: requiring("etag") } as never,
          },
        },
        handler: () => ({ id: 1 }) as never,
      }),
    ).toThrow('The 200 entry of a response map has "header"');
  });

  test("a missing cookie is a broken contract", async () => {
    const res = await post("/no-session");

    expect(res.status).toBe(500);
    expect((reports[0]?.error as Error | undefined)?.message).toBe(
      "Handler's response cookies do not match their schema",
    );
  });

  test("a Response the handler builds is not checked", async () => {
    const res = await post("/built");

    expect(res.status).toBe(201);
    expect(seen).toEqual([]);
  });

  test("validateResponses: false checks neither", async () => {
    const res = await post("/forgot", unchecked);

    expect(res.status).toBe(201);
    expect(seen).toEqual([]);
  });
});
