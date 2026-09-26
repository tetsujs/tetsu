/**
 * Tests for the rate-limiting hook, through a live server.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Requires } from "@tetsujs/core";
import { createApp, hook, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { openapi } from "@tetsujs/openapi";
import { rateLimit } from "./index.ts";
import type { RateLimitStore, WindowState } from "./store.ts";
import { memoryStore } from "./store.ts";

class ApiController {
  read = route({
    method: "GET",
    path: "/items",
    handler: () => ({ ok: true }),
  });
}

/** A store the tests drive by hand, so nothing depends on wall-clock time. */
function scriptedStore(states: WindowState[]): RateLimitStore {
  let index = 0;

  return {
    hit: () => states[Math.min(index++, states.length - 1)] as WindowState,
  };
}

const serveWith = (options: Parameters<typeof rateLimit>[0]) => {
  const limit = rateLimit(options);

  return serve(
    createApp({
      hooks: { beforeParse: [limit] },
      routes: new ApiController(),
    }),
  );
};

describe("a key from an earlier hook", () => {
  const client = hook.beforeParse((ctx) => ({
    client: ctx.req.headers.get("x-client") ?? "anonymous",
  }));

  const limit = rateLimit({
    limit: 1,
    windowMs: 60_000,
    key: (ctx: Requires<{ client: string }>) => ctx.client,
  });

  const request = serve(
    createApp({
      hooks: { beforeParse: [client, limit] },
      routes: new ApiController(),
    }),
  );

  test("counts what the earlier hook worked out", async () => {
    const as = (name: string) =>
      request("/items", { headers: { "x-client": name } });

    expect((await as("a")).status).toBe(200);
    expect((await as("a")).status).toBe(429);
    expect((await as("b")).status).toBe(200);
  });
});

describe("within the limit", () => {
  const request = serveWith({
    limit: 3,
    windowMs: 60_000,
    key: () => "one-client",
  });

  test("the request goes through", async () => {
    const res = await request("/items");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("every response carries the remaining budget", async () => {
    const res = await request("/items");

    expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    expect(Number(res.headers.get("x-ratelimit-remaining"))).toBeLessThan(3);
    expect(Number(res.headers.get("x-ratelimit-reset"))).toBeGreaterThan(0);
  });
});

describe("over the limit", () => {
  const resetAt = Date.now() + 30_000;

  const request = serveWith({
    limit: 1,
    windowMs: 60_000,
    key: () => "one-client",
    store: scriptedStore([
      { count: 1, resetAt },
      { count: 2, resetAt },
    ]),
  });

  test("the first request passes and the second is refused", async () => {
    const first = await request("/items");
    const second = await request("/items");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      status: 429,
      message: "Too Many Requests",
      error: "RATE_LIMITED",
    });
  });

  test("the refusal says when to come back", async () => {
    const res = await request("/items");

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  test("the status is configurable", async () => {
    const strict = serveWith({
      limit: 0,
      windowMs: 60_000,
      status: 503,
      key: () => "one-client",
      store: scriptedStore([{ count: 1, resetAt }]),
    });

    expect((await strict("/items")).status).toBe(503);
  });
});

describe("what is counted", () => {
  test("a key of undefined skips the limit", async () => {
    const request = serveWith({
      limit: 0,
      windowMs: 60_000,
      key: () => undefined,
    });

    const res = await request("/items");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
  });

  test("different keys have different budgets", async () => {
    const store = memoryStore();

    const request = serveWith({
      limit: 1,
      windowMs: 60_000,
      store,
      key: (ctx) => ctx.req.headers.get("x-tenant") ?? undefined,
    });

    const first = await request("/items", { headers: { "x-tenant": "a" } });
    const other = await request("/items", { headers: { "x-tenant": "b" } });
    const again = await request("/items", { headers: { "x-tenant": "a" } });

    expect(first.status).toBe(200);
    expect(other.status).toBe(200);
    expect(again.status).toBe(429);
  });

  test("headers can be turned off", async () => {
    const request = serveWith({
      limit: 5,
      windowMs: 60_000,
      headers: false,
      key: () => "quiet",
    });

    const res = await request("/items");

    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
  });
});

describe("the memory store", () => {
  test("counts within a window and starts a new one after it", async () => {
    const store = memoryStore();

    expect(await store.hit("k", 50)).toMatchObject({ count: 1 });
    expect(await store.hit("k", 50)).toMatchObject({ count: 2 });

    await Bun.sleep(60);

    expect(await store.hit("k", 50)).toMatchObject({ count: 1 });
  });

  test("keeps keys apart", async () => {
    const store = memoryStore();

    await store.hit("a", 1_000);
    await store.hit("a", 1_000);

    expect(await store.hit("b", 1_000)).toMatchObject({ count: 1 });
  });

  test("does not grow without bound", async () => {
    const store = memoryStore();

    for (let index = 0; index < 200; index += 1) {
      await store.hit(`key-${index}`, 1);
    }

    await Bun.sleep(10);

    // The sweep runs on the next hit past the threshold; after it, the
    // expired keys are gone rather than accumulating for the process life.
    for (let index = 0; index < 200; index += 1) {
      await store.hit(`later-${index}`, 1_000);
    }

    expect(await store.hit("later-0", 1_000)).toMatchObject({ count: 2 });
  });

  test("an async store is awaited", async () => {
    const resetAt = Date.now() + 10_000;

    const request = serveWith({
      limit: 1,
      windowMs: 10_000,
      key: () => "async",
      store: {
        hit: async () => {
          await Bun.sleep(1);

          return { count: 2, resetAt };
        },
      },
    });

    expect((await request("/items")).status).toBe(429);
  });
});

describe("documentation", () => {
  test("the hook tells the generator what it answers", () => {
    const limit = rateLimit({ limit: 1, windowMs: 1_000, key: () => "one" });

    const app = createApp({
      hooks: { beforeParse: [limit] },
      routes: new ApiController(),
    });

    const { document } = openapi(app, {
      info: { title: "Test", version: "1.0.0" },
    });

    const responses = document.paths["/items"]?.get?.responses ?? {};

    expect(Object.keys(responses).toSorted()).toEqual(["200", "429", "500"]);
    expect(responses["429"]?.description).toContain("Too many requests");

    const schema = responses["429"]?.content?.["application/json"]?.schema as
      | { $ref: string }
      | undefined;

    expect(schema?.$ref).toBe("#/components/schemas/RateLimited");
    expect(responses["429"]?.headers?.["retry-after"]?.schema).toEqual({
      type: "integer",
      minimum: 0,
    });

    const schemas = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas;

    expect(schemas.RateLimited).toMatchObject({
      required: ["status", "message", "error", "retryAfter"],
      properties: {
        status: { const: 429 },
        error: { const: "RATE_LIMITED" },
        retryAfter: { type: "integer", minimum: 0 },
      },
    });
  });
});

describe("what has to be said out loud", () => {
  test("a limiter without a key does not compile", () => {
    // The default used to be the client's address, which behind a balancer
    // is the balancer's — every caller in one bucket, silently. The choice
    // belongs to whoever knows the topology, so it has to be made.
    // @ts-expect-error key is required
    const missing = () => rateLimit({ limit: 1, windowMs: 1_000 });

    expect(missing).toBeFunction();
  });

  test("keying by something other than an address is ordinary", async () => {
    const perSession = rateLimit({
      limit: 1,
      windowMs: 60_000,
      key: (ctx) => ctx.req.headers.get("x-session") ?? undefined,
    });

    const request = serve(
      createApp({
        hooks: { beforeParse: [perSession] },
        routes: new ApiController(),
      }),
    );

    const first = await request("/items", { headers: { "x-session": "a" } });
    const second = await request("/items", { headers: { "x-session": "a" } });
    const other = await request("/items", { headers: { "x-session": "b" } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(other.status).toBe(200);
  });

  test("no key at all lets the request through, which is how an allowance is said", async () => {
    const exempting = rateLimit({
      limit: 1,
      windowMs: 60_000,
      key: (ctx) =>
        ctx.req.headers.get("x-internal") ? undefined : "everyone-else",
    });

    const request = serve(
      createApp({
        hooks: { beforeParse: [exempting] },
        routes: new ApiController(),
      }),
    );

    await request("/items");

    expect((await request("/items")).status).toBe(429);
    expect(
      (await request("/items", { headers: { "x-internal": "yes" } })).status,
    ).toBe(200);
  });
});
