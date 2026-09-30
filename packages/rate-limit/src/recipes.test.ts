/**
 * The README's recipes, as they are written.
 *
 * A limiter is a defence, and a recipe for one that works as written can
 * still leave open what it defends: a key the client chooses, an
 * exemption the client asks for, a store that locks a client out for
 * good after one timeout. Each recipe is copied here unchanged — only
 * what it leaves to the reader, such as the list of internal addresses,
 * is filled in — and asked the question it has to answer.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { Requires } from "@tetsujs/core";
import { createApp, HttpError, hook, route, signedCookie } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { RateLimitStore } from "./index.ts";
import { rateLimit } from "./index.ts";

const routes = {
  login: route({
    method: "POST",
    path: "/login",
    handler: () => ({ ok: true }),
  }),
};

const attempt = (cookie?: string): RequestInit => ({
  method: "POST",
  headers: cookie ? { cookie } : {},
});

describe("Usage", () => {
  const limit = rateLimit({
    limit: 60,
    windowMs: 60_000,
    key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
  });

  const request = serve(createApp({ hooks: { beforeParse: [limit] }, routes }));

  test("a client that changes or drops its cookie is still counted", async () => {
    const statuses: number[] = [];

    for (let index = 0; index < 61; index += 1) {
      const cookie = index % 2 === 0 ? undefined : `session=x${index}`;

      statuses.push((await request("/login", attempt(cookie))).status);
    }

    expect(statuses.filter((status) => status === 429)).toEqual([429]);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("an allowance for internal callers", () => {
  // The recipe, with the list it leaves to the reader as a parameter.
  const allowing = (internal: ReadonlySet<string>) =>
    rateLimit({
      limit: 1,
      windowMs: 60_000,
      key: (ctx) => {
        const address = ctx.server
          .requestIP(ctx.req)
          ?.address.replace(/^::ffff:/, "");

        return address && internal.has(address) ? undefined : address;
      },
    });

  const serving = (internal: ReadonlySet<string>) =>
    serve(createApp({ hooks: { beforeParse: [allowing(internal)] }, routes }), {
      hostname: "127.0.0.1",
    });

  test("an address on the list is not counted", async () => {
    const request = serving(new Set(["127.0.0.1"]));

    await request("/login", attempt());

    expect((await request("/login", attempt())).status).toBe(200);
  });

  test("a header a client sends does not make it internal", async () => {
    const request = serving(new Set(["10.0.0.5"]));
    const claiming: RequestInit = {
      method: "POST",
      headers: { "x-internal": "1" },
    };

    await request("/login", claiming);

    expect((await request("/login", claiming)).status).toBe(429);
  });
});

describe("a shared store", () => {
  /**
   * The commands the recipe uses, with Redis's meaning, in memory — and a
   * first `PEXPIRE` that times out, as a Redis under load can.
   */
  function flakyRedis() {
    const values = new Map<string, number>();
    const expiries = new Map<string, number>();
    let failures = 1;

    const alive = (key: string) => {
      const expiry = expiries.get(key);

      if (expiry !== undefined && expiry <= Date.now()) {
        values.delete(key);
        expiries.delete(key);
      }
    };

    return {
      incr: async (key: string) => {
        alive(key);
        values.set(key, (values.get(key) ?? 0) + 1);

        return values.get(key) as number;
      },
      pexpire: async (key: string, ms: number, mode?: "NX") => {
        if (failures > 0) {
          failures -= 1;

          throw new Error("ETIMEDOUT");
        }

        if (mode === "NX" && expiries.has(key)) {
          return 0;
        }

        expiries.set(key, Date.now() + ms);

        return 1;
      },
      pttl: async (key: string) => {
        const expiry = expiries.get(key);

        return expiry === undefined ? -1 : expiry - Date.now();
      },
    };
  }

  test("one timeout does not lock a client out for good", async () => {
    const redis = flakyRedis();

    const redisStore: RateLimitStore = {
      hit: async (key, windowMs) => {
        const count = await redis.incr(key);
        await redis.pexpire(key, windowMs, "NX");
        return { count, resetAt: Date.now() + (await redis.pttl(key)) };
      },
    };

    const limit = rateLimit({
      name: "shop-login",
      limit: 2,
      windowMs: 100,
      key: () => "client",
      store: redisStore,
    });

    const request = serve(
      createApp({
        hooks: { beforeParse: [limit] },
        routes,
        reportError: () => undefined,
      }),
    );

    expect((await request("/login", attempt())).status).toBe(500);
    expect((await request("/login", attempt())).status).toBe(200);
    expect((await request("/login", attempt())).status).toBe(429);

    await Bun.sleep(150);

    expect((await request("/login", attempt())).status).toBe(200);
  });

  test("a refusal never says to come back at once", async () => {
    const stale: RateLimitStore = {
      hit: () => ({ count: 2, resetAt: Date.now() - 1_000 }),
    };

    const limit = rateLimit({
      name: "stale",
      limit: 1,
      windowMs: 60_000,
      key: () => "client",
      store: stale,
    });

    const res = await serve(
      createApp({ hooks: { beforeParse: [limit] }, routes }),
    )("/login", attempt());

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(((await res.json()) as { retryAfter: number }).retryAfter).toBe(1);
  });
});

describe("a limit per user, on a signed session", () => {
  const auth = hook.beforeParse((ctx) => {
    const userId = signedCookie(ctx, "session");
    if (!userId) throw new HttpError(401);
    return { userId };
  });

  const perUser = rateLimit({
    limit: 2,
    windowMs: 60_000,
    key: (ctx: Requires<{ userId: string }>) => ctx.userId,
  });

  const request = serve(
    createApp({
      cookies: { secret: "a-secret-for-the-test", sign: ["session"] },
      routes: {
        login: route({
          method: "POST",
          path: "/login",
          handler: (ctx) => {
            ctx.out.cookies.set("session", "u1");

            return null;
          },
        }),
        orders: route({
          method: "POST",
          path: "/orders",
          hooks: { beforeParse: [auth, perUser] },
          handler: (ctx) => ({ userId: ctx.userId }),
        }),
      },
    }),
  );

  test("a junk session in front of the real one is not a new budget", async () => {
    const login = await request("/login", { method: "POST" });
    const session = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    const statuses: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const res = await request("/orders", {
        method: "POST",
        headers: { cookie: `session=junk${index}; ${session}` },
      });

      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 429, 429, 429]);
  });

  test("a forged session never reaches the limiter", async () => {
    const res = await request("/orders", {
      method: "POST",
      headers: { cookie: "session=u1" },
    });

    expect(res.status).toBe(401);
  });
});
