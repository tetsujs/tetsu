/**
 * Tests for what one budget is: the limiter, its name in a shared store,
 * and the route under `perRoute`.
 *
 * A store holds the counters of every limiter handed to it, and a counter
 * is found by its key alone. Keyed by the client alone, two limiters on
 * one store counted into one counter: a strict login limit lived in the
 * window of a loose global one. A name keeps them apart, and is what a
 * fleet of servers shares a limit by.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Requires, StandardSchemaV1 } from "@tetsujs/core";
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { rateLimit } from "./index.ts";
import type { RateLimitStore } from "./store.ts";
import { memoryStore } from "./store.ts";

const handler = () => ({ ok: true });

const routes = {
  items: route({ method: "GET", path: "/items", handler }),
  orders: route({ method: "GET", path: "/orders", handler }),
  order: route({ method: "GET", path: "/orders/:id", handler }),
};

/** A memory store that also remembers every key it was asked about. */
function recordingStore(): RateLimitStore & { readonly keys: string[] } {
  const inner = memoryStore();
  const keys: string[] = [];

  return {
    keys,
    hit: (key, windowMs) => {
      keys.push(key);

      return inner.hit(key, windowMs);
    },
  };
}

describe("options that would switch the limit off", () => {
  const valid = { limit: 5, windowMs: 60_000, key: () => "client" };

  test.each([
    ["NaN, as a missing variable reads", Number(undefined)],
    ["zero", 0],
    ["negative", -1_000],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("a window that is %s is refused", (_, windowMs) => {
    expect(() => rateLimit({ ...valid, windowMs })).toThrow(/windowMs/);
  });

  test.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["fractional", 1.5],
  ])("a limit that is %s is refused", (_, limit) => {
    expect(() => rateLimit({ ...valid, limit })).toThrow(/limit/);
  });

  test("a limit of zero refuses everything, as it says", async () => {
    const request = serve(
      createApp({
        hooks: { beforeParse: [rateLimit({ ...valid, limit: 0 })] },
        routes,
      }),
    );

    expect((await request("/items")).status).toBe(429);
  });
});

describe("a name in a shared store", () => {
  test("two limiters on one store count apart", async () => {
    const store = memoryStore();
    const key = () => "client";
    const everything = rateLimit({
      name: "everything",
      store,
      limit: 100,
      windowMs: 60_000,
      key,
    });
    const login = rateLimit({
      name: "login",
      store,
      limit: 1,
      windowMs: 60_000,
      key,
    });

    const request = serve(
      createApp({
        hooks: { beforeParse: [everything] },
        routes: {
          login: route({
            method: "POST",
            path: "/login",
            hooks: { beforeParse: [login] },
            handler,
          }),
        },
      }),
    );

    expect((await request("/login", { method: "POST" })).status).toBe(200);
    expect((await request("/login", { method: "POST" })).status).toBe(429);
  });

  test("the name leads the key in the store", async () => {
    const store = recordingStore();
    const limit = rateLimit({
      name: "shop-login",
      store,
      limit: 5,
      windowMs: 60_000,
      key: () => "203.0.113.7",
    });

    await serve(createApp({ hooks: { beforeParse: [limit] }, routes }))(
      "/items",
    );

    expect(store.keys).toEqual(["shop-login:203.0.113.7"]);
  });

  test("a store without a name is refused", () => {
    const store = memoryStore();

    expect(() =>
      // @ts-expect-error a store needs a name
      rateLimit({ store, limit: 5, windowMs: 60_000, key: () => "client" }),
    ).toThrow(/name/);
  });

  test("a name without a store is refused", () => {
    expect(() =>
      // @ts-expect-error a name means nothing without a store
      rateLimit({ name: "login", limit: 5, windowMs: 60_000, key: () => "c" }),
    ).toThrow(/store/);
  });

  test("one name on one store with other settings is refused", () => {
    const store = memoryStore();
    const key = () => "client";

    rateLimit({ name: "login", store, limit: 5, windowMs: 60_000, key });

    expect(() =>
      rateLimit({ name: "login", store, limit: 100, windowMs: 1_000, key }),
    ).toThrow(/login/);
  });

  test("one name on one store with the same settings is one budget", async () => {
    // What rebuilding an application does — in a test, once per test — and
    // what every server of a fleet does with its own copy of the limiter.
    const store = memoryStore();
    const make = () =>
      rateLimit({
        name: "login",
        store,
        limit: 1,
        windowMs: 60_000,
        key: () => "client",
      });

    const first = serve(
      createApp({ hooks: { beforeParse: [make()] }, routes }),
    );
    const second = serve(
      createApp({ hooks: { beforeParse: [make()] }, routes }),
    );

    expect((await first("/items")).status).toBe(200);
    expect((await second("/items")).status).toBe(429);
  });

  test("the same name on another store is another budget", () => {
    const key = () => "client";

    rateLimit({
      name: "login",
      store: memoryStore(),
      limit: 5,
      windowMs: 1,
      key,
    });

    expect(() =>
      rateLimit({
        name: "login",
        store: memoryStore(),
        limit: 100,
        windowMs: 60_000,
        key,
      }),
    ).not.toThrow();
  });
});

describe("a budget per route", () => {
  test("without perRoute, one limiter is one budget across its routes", async () => {
    const limit = rateLimit({ limit: 1, windowMs: 60_000, key: () => "c" });
    const request = serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    );

    expect((await request("/items")).status).toBe(200);
    expect((await request("/orders")).status).toBe(429);
  });

  test("with perRoute, each route has its own", async () => {
    const limit = rateLimit({
      perRoute: true,
      limit: 1,
      windowMs: 60_000,
      key: () => "c",
    });
    const request = serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    );

    expect((await request("/items")).status).toBe(200);
    expect((await request("/orders")).status).toBe(200);
    expect((await request("/items")).status).toBe(429);
  });

  test("a route is its template, so one path's identifiers share it", async () => {
    const limit = rateLimit({
      perRoute: true,
      limit: 1,
      windowMs: 60_000,
      key: () => "c",
    });
    const request = serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    );

    expect((await request("/orders/1")).status).toBe(200);
    expect((await request("/orders/2")).status).toBe(429);
  });

  test("requests no route answers share one budget", async () => {
    const limit = rateLimit({
      perRoute: true,
      limit: 1,
      windowMs: 60_000,
      key: () => "c",
    });
    const request = serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    );

    expect((await request("/nothing-here")).status).toBe(404);
    expect((await request("/nor-here")).status).toBe(429);
    expect((await request("/items", { method: "DELETE" })).status).toBe(429);
  });

  test("the route follows the name in the store", async () => {
    const store = recordingStore();
    const limit = rateLimit({
      name: "endpoints",
      store,
      perRoute: true,
      limit: 5,
      windowMs: 60_000,
      key: () => "c",
    });
    const request = serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    );

    await request("/orders/42");
    await request("/nothing-here");

    expect(store.keys).toEqual([
      "endpoints:GET:/orders/:id:c",
      "endpoints:unrouted:c",
    ]);
  });
});

describe("a limit after the body is read", () => {
  type Credentials = { email: string; password: string };

  const Login: StandardSchemaV1<unknown, Credentials> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as Credentials }),
    },
  };

  const perAccount = rateLimit({
    slot: "beforeHandle",
    limit: 2,
    windowMs: 60_000,
    key: (ctx: Requires<{ body: { email: string } }>) => ctx.body.email,
  });

  const request = serve(
    createApp({
      routes: {
        login: route({
          method: "POST",
          path: "/login",
          schema: { body: Login },
          hooks: { beforeHandle: [perAccount] },
          handler: () => ({ ok: true }),
        }),
      },
    }),
  );

  const attempt = (email: string) =>
    request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "guess" }),
    });

  test("counts by the account the body names", async () => {
    const statuses = [];

    for (let index = 0; index < 3; index += 1) {
      statuses.push((await attempt("ada@example.com")).status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect((await attempt("grace@example.com")).status).toBe(200);
  });

  test("refuses as the limiter always does", async () => {
    const res = await attempt("ada@example.com");

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a slot a limit cannot protect from is refused", () => {
    expect(() =>
      rateLimit({
        slot: "afterResponse" as "beforeHandle",
        limit: 1,
        windowMs: 1_000,
        key: () => "k",
      }),
    ).toThrow(/slot/);
  });

  test("one name on one store in two slots is two limiters, refused", () => {
    const store = memoryStore();
    const key = () => "k";

    rateLimit({ name: "login", store, limit: 5, windowMs: 60_000, key });

    expect(() =>
      rateLimit({
        slot: "beforeHandle",
        name: "login",
        store,
        limit: 5,
        windowMs: 60_000,
        key,
      }),
    ).toThrow(/login/);
  });
});
