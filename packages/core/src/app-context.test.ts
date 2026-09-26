/**
 * Integration tests: the request context through a live server.
 *
 * `ctx.server` access, `ctx.route` naming the endpoint, `ctx.out.headers`
 * surviving every outcome, extension safety (prototype pollution,
 * pipeline-owned fields), and Bun's cookie map flowing through the
 * pipeline.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { HttpError } from "./error.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";
import type { StandardSchemaV1 } from "./schema.ts";

describe("server access and repeated headers", () => {
  class ConnectionController {
    who = route({
      method: "GET",
      path: "/who",
      handler: (ctx) => ({
        address: ctx.server.requestIP(ctx.req)?.address ?? null,
        port: ctx.server.port,
      }),
    });

    cookies = route({
      method: "GET",
      path: "/cookies",
      handler: (ctx) => {
        ctx.out.headers.append("set-cookie", "session=abc; HttpOnly");
        ctx.out.headers.append("set-cookie", "theme=dark");

        return { ok: true };
      },
    });
  }

  const connectionRequest = serve(
    createApp({ routes: new ConnectionController() }),
  );

  test("ctx.server exposes connection facts the Request lacks", async () => {
    const res = await connectionRequest("/who");
    const body = (await res.json()) as { address: string | null; port: number };

    expect(typeof body.address).toBe("string");
    expect(typeof body.port).toBe("number");
  });

  test("a test can be an IPv4 client, where it listens on IPv4", async () => {
    // Without a hostname Bun listens on both stacks, and a client that
    // connects over IPv4 is reported as `::ffff:127.0.0.1` — a test of a
    // check against `127.0.0.1`, a trusted proxy, could not be written.
    const request = serve(createApp({ routes: new ConnectionController() }), {
      hostname: "127.0.0.1",
    });

    const body = (await (await request("/who")).json()) as {
      address: string | null;
    };

    expect(request.url.hostname).toBe("127.0.0.1");
    expect(body.address).toBe("127.0.0.1");
  });

  test("a Headers instance carries repeated Set-Cookie", async () => {
    const res = await connectionRequest("/cookies");

    expect(res.headers.getSetCookie()).toEqual([
      "session=abc; HttpOnly",
      "theme=dark",
    ]);
  });
});

describe("ctx.route", () => {
  const seen: unknown[] = [];

  const rename = hook.beforeParse(() => ({
    route: { method: "GET", path: "/forged", controller: "Forged" },
  }));

  class CatalogController {
    show = route({
      method: "GET",
      path: "/items/:id",
      handler: (ctx) => {
        seen.push(ctx.route);

        return { route: ctx.route };
      },
    });

    create = route({
      method: "POST",
      path: "/items",
      handler: (ctx) => ({ route: ctx.route }),
    });

    forged = route({
      method: "GET",
      path: "/forged-check",
      hooks: { beforeParse: [rename] },
      handler: (ctx) => ({ route: ctx.route }),
    });
  }

  const observed: (string | null)[] = [];

  const observe = hook.afterResponse((ctx) => {
    observed.push(ctx.route?.path ?? null);
  });

  const request = serve(
    createApp({
      hooks: { afterResponse: [observe] },
      routes: new CatalogController(),
    }),
  );

  test("names the endpoint as declared, not as the request spelled it", async () => {
    const res = await request("/items/42");

    expect(await res.json()).toEqual({
      route: {
        method: "GET",
        path: "/items/:id",
        controller: "CatalogController",
        name: "show",
      },
    });
  });

  test("is the same object for every request that matches", async () => {
    seen.length = 0;

    await request("/items/1");
    await request("/items/2");

    // Built once per table entry, not per request: an observer may hold it
    // and a metric may key on it.
    expect(seen[0]).toBe(seen[1]);
  });

  test("is absent where nothing matched", async () => {
    observed.length = 0;

    await request("/nothing-here");
    await Bun.sleep(20);

    expect(observed).toEqual([null]);
  });

  test("is absent on a method the path does not answer", async () => {
    observed.length = 0;

    const res = await request("/items/42", { method: "DELETE" });

    await Bun.sleep(20);

    expect(res.status).toBe(405);
    expect(observed).toEqual([null]);
  });

  test("names the GET route on a HEAD of it", async () => {
    observed.length = 0;

    const res = await request("/items/42", { method: "HEAD" });

    await Bun.sleep(20);

    expect(res.status).toBe(200);
    expect(observed).toEqual(["/items/:id"]);
  });

  test("carries the prefixes the groups added", async () => {
    // The table's path, not the route's own: a controller mounted under a
    // group answers a path it never wrote down, and that is the one an
    // observer has to be able to name.
    const nested = serve(
      createApp({
        routes: group("/api", {
          children: [group("/v2", { children: [new CatalogController()] })],
        }),
      }),
    );

    const res = await nested("/api/v2/items/42");

    expect(await res.json()).toMatchObject({
      route: { path: "/api/v2/items/:id" },
    });
  });

  test("cannot be renamed by a hook", async () => {
    const res = await request("/forged-check");

    expect(await res.json()).toEqual({
      route: {
        method: "GET",
        path: "/forged-check",
        controller: "CatalogController",
        name: "forged",
      },
    });
  });
});

describe("context extension safety", () => {
  const optionalAuth = hook.beforeParse((ctx) =>
    ctx.req.headers.get("authorization") === "token"
      ? { user: { id: "u1", role: "user" } }
      : undefined,
  );

  const normalizeBody = hook.beforeValidation((ctx) => ({
    body: { ...(ctx.body as Record<string, unknown>) },
  }));

  const requireAdmin = hook.beforeHandle(
    (ctx: Requires<{ user?: { role: string } }>) => {
      if (ctx.user?.role !== "admin") {
        throw new HttpError(403, { code: "forbidden" });
      }
    },
  );

  const Passthrough: StandardSchemaV1<unknown, Record<string, unknown>> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as Record<string, unknown> }),
    },
  };

  class AdminActionController {
    act = route({
      method: "POST",
      path: "/admin/act",
      schema: { body: Passthrough },
      hooks: {
        beforeParse: [optionalAuth],
        beforeValidation: [normalizeBody],
        beforeHandle: [requireAdmin],
      },
      handler: () => ({ didAdminThing: true }),
    });
  }

  class ProbeController {
    echo = route({
      method: "POST",
      path: "/echo-ctx",
      schema: { body: Passthrough },
      hooks: { beforeValidation: [normalizeBody] },
      handler: (ctx) => ({
        method: ctx.req.method,
        status: ctx.out.status ?? null,
        body: ctx.body,
      }),
    });
  }

  class ProtoProbeController {
    query = route({
      method: "GET",
      path: "/proto/query",
      schema: { query: Passthrough },
      handler: (ctx) => ({
        a: ctx.query.a ?? null,
        proto:
          Object.getOwnPropertyDescriptor(ctx.query, "__proto__")?.value ??
          null,
        prototype: String(Object.getPrototypeOf(ctx.query)),
      }),
    });

    headers = route({
      method: "GET",
      path: "/proto/headers",
      schema: { headers: Passthrough },
      handler: (ctx) => ({
        proto:
          Object.getOwnPropertyDescriptor(ctx.headers, "__proto__")?.value ??
          null,
        polluted: ({} as { evil?: unknown }).evil !== undefined,
      }),
    });
  }

  const safetyRequest = serve(
    createApp({
      routes: [
        new AdminActionController(),
        new ProbeController(),
        new ProtoProbeController(),
      ],
    }),
  );

  const send = (path: string, body: unknown) =>
    safetyRequest(path, { method: "POST", body: JSON.stringify(body) });

  test("a __proto__ payload cannot forge an authenticated context", async () => {
    const res = await send("/admin/act", {
      __proto__: { user: { id: "attacker", role: "admin" } },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden" });
  });

  test("a __proto__ payload does not leak into other requests", async () => {
    const res = await send("/echo-ctx", { a: 1 });

    expect(await res.json()).toEqual({
      method: "POST",
      status: null,
      body: { a: 1 },
    });
  });

  test("a body payload named like a pipeline field stays data", async () => {
    const res = await send("/echo-ctx", {
      req: "pwned",
      set: { status: 418, headers: { "x-attacker": "1" } },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-attacker")).toBeNull();
    expect(await res.json()).toMatchObject({ method: "POST", status: null });
  });

  test("a __proto__ query parameter stays plain data", async () => {
    const res = await safetyRequest("/proto/query?__proto__=evil&a=1");

    expect(await res.json()).toEqual({
      a: "1",
      proto: "evil",
      prototype: "null",
    });
  });

  test("repeated __proto__ query parameters cannot re-point the prototype", async () => {
    const res = await safetyRequest("/proto/query?__proto__=x&__proto__=y");

    expect(await res.json()).toEqual({
      a: null,
      proto: ["x", "y"],
      prototype: "null",
    });
  });

  test("a __proto__ request header stays plain data", async () => {
    const res = await safetyRequest("/proto/headers", {
      headers: [["__proto__", "evil"]],
    });

    expect(await res.json()).toEqual({ proto: "evil", polluted: false });
  });

  test("a hook cannot replace ctx.server", async () => {
    const forged = {
      requestIP: (_req: Request) => ({ address: "1.2.3.4" }),
    };

    const hijack = hook.beforeParse(() => ({ server: forged }));

    class HijackController {
      who = route({
        method: "GET",
        path: "/who",
        hooks: { beforeParse: [hijack] },
        handler: (ctx) => ({
          address: ctx.server.requestIP(ctx.req)?.address ?? null,
        }),
      });
    }

    const hijackRequest = serve(createApp({ routes: new HijackController() }));

    const res = await hijackRequest("/who");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { address: string }).address).not.toBe(
      "1.2.3.4",
    );
  });

  describe("every protected key", () => {
    const forged = { forged: true };

    const forge = hook.beforeParse((ctx) => {
      const extension: Record<string, unknown> = {};

      Object.defineProperty(extension, String(ctx.params.key), {
        value: forged,
        enumerable: true,
        writable: true,
        configurable: true,
      });

      return extension;
    });

    class ForgeController {
      probe = route({
        method: "GET",
        path: "/forge/:key",
        hooks: { beforeParse: [forge] },
        handler: (ctx) => {
          const seen = ctx as unknown as Record<string, unknown>;

          return {
            replaced: seen[ctx.params.key] === forged,
            protoIntact: Object.getPrototypeOf(seen) === Object.prototype,
          };
        },
      });
    }

    const forgeRequest = serve(createApp({ routes: new ForgeController() }));

    const keys = [
      "__proto__",
      "constructor",
      "prototype",
      "req",
      "server",
      "out",
      "route",
      "res",
      "error",
    ];

    for (const key of keys) {
      test(`a hook cannot contribute "${key}"`, async () => {
        const res = await forgeRequest(`/forge/${key}`);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          replaced: false,
          protoIntact: true,
        });
      });
    }
  });

  test("protected names inside the body stay data", async () => {
    class DataController {
      echo = route({
        method: "POST",
        path: "/data",
        schema: { body: Passthrough },
        handler: (ctx) => ({
          keys: Object.keys(ctx.body),
          constructorField: ctx.body.constructor,
          reqField: ctx.body.req,
          reqIntact: ctx.req instanceof Request,
        }),
      });
    }

    const dataRequest = serve(createApp({ routes: new DataController() }));

    const res = await dataRequest("/data", {
      method: "POST",
      body: '{"constructor":"c","req":"r","server":"s"}',
    });

    expect(await res.json()).toEqual({
      keys: ["constructor", "req", "server"],
      constructorField: "c",
      reqField: "r",
      reqIntact: true,
    });
  });

  test("only own enumerable string keys of a hook return are merged", async () => {
    const traceKey = Symbol("trace");

    class Session {
      constructor(readonly id: string) {}

      get expired(): boolean {
        return false;
      }

      label(): string {
        return `session ${this.id}`;
      }
    }

    const fromInstance = hook.beforeParse(() => new Session("s1"));

    const withSymbol = hook.beforeParse(() => ({
      [traceKey]: "t1",
      tenant: "acme",
    }));

    class ContractController {
      probe = route({
        method: "GET",
        path: "/contribution",
        hooks: { beforeParse: [fromInstance, withSymbol] },
        handler: (ctx) => {
          const seen = ctx as unknown as Record<string, unknown> &
            Record<symbol, unknown>;

          return {
            own: seen.id ?? null,
            tenant: seen.tenant ?? null,
            prototypeMethod: typeof seen.label,
            prototypeGetter: seen.expired ?? null,
            symbolKey: seen[traceKey] ?? null,
          };
        },
      });
    }

    const contractRequest = serve(
      createApp({ routes: new ContractController() }),
    );

    const res = await contractRequest("/contribution");

    expect(await res.json()).toEqual({
      own: "s1",
      tenant: "acme",
      prototypeMethod: "undefined",
      prototypeGetter: null,
      symbolKey: null,
    });
  });

  test("normalizing data fields still works", async () => {
    const trimming = hook.beforeValidation((ctx) => ({
      body: { trimmed: String((ctx.body as { raw: string }).raw).trim() },
    }));

    class TrimController {
      post = route({
        method: "POST",
        path: "/trim",
        schema: { body: Passthrough },
        hooks: { beforeValidation: [trimming] },
        handler: (ctx) => ctx.body,
      });
    }

    const trimRequest = serve(createApp({ routes: new TrimController() }));

    const res = await trimRequest("/trim", {
      method: "POST",
      body: JSON.stringify({ raw: "  spaced  " }),
    });

    expect(await res.json()).toEqual({ trimmed: "spaced" });
  });
});

describe("ctx.out.headers survive every outcome", () => {
  const requestId = hook.beforeParse((ctx) => {
    ctx.out.headers.set("x-request-id", "rid-1");
  });

  const rotate = hook.beforeParse((ctx) => {
    ctx.out.headers.append("set-cookie", "session=next; HttpOnly");
    ctx.out.headers.append("set-cookie", "theme=dark");
  });

  const deny = hook.beforeHandle(() => {
    throw new HttpError(401, { code: "unauthorized" });
  });

  const gate = hook.beforeHandle(() =>
    Response.json({ gated: true }, { status: 429 }),
  );

  class SetHeadersController {
    fails = route({
      method: "GET",
      path: "/fails",
      hooks: { beforeParse: [requestId], beforeHandle: [deny] },
      handler: () => ({ ok: true }),
    });

    gated = route({
      method: "GET",
      path: "/gated",
      hooks: { beforeParse: [requestId], beforeHandle: [gate] },
      handler: () => ({ ok: true }),
    });

    rotated = route({
      method: "GET",
      path: "/rotated",
      hooks: { beforeParse: [rotate], beforeHandle: [deny] },
      handler: () => ({ ok: true }),
    });

    ok = route({
      method: "GET",
      path: "/ok",
      hooks: { beforeParse: [rotate] },
      handler: () => ({ ok: true }),
    });

    composed = route({
      method: "GET",
      path: "/composed",
      hooks: {
        beforeParse: [requestId],
        beforeResponse: [
          hook.beforeResponse((ctx) => {
            ctx.out.headers.set("cache-control", "no-store");
          }),
        ],
      },
      handler: () => ({ ok: true }),
    });
  }

  const setRequest = serve(createApp({ routes: new SetHeadersController() }));

  test("headers set by a hook survive an error response", async () => {
    const res = await setRequest("/fails");

    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBe("rid-1");
  });

  test("headers set by a hook survive a short-circuit Response", async () => {
    const res = await setRequest("/gated");

    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("rid-1");
  });

  test("a cookie rotation survives the 401 it accompanies", async () => {
    const res = await setRequest("/rotated");

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([
      "session=next; HttpOnly",
      "theme=dark",
    ]);
  });

  test("cookies are applied exactly once on the success path", async () => {
    const res = await setRequest("/ok");

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([
      "session=next; HttpOnly",
      "theme=dark",
    ]);
  });

  test("two hooks writing headers compose instead of clobbering", async () => {
    const res = await setRequest("/composed");

    expect(res.headers.get("x-request-id")).toBe("rid-1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Bun cookie map through the pipeline", () => {
  const sessionize = hook.beforeParse((ctx) => {
    ctx.req.cookies?.set("session", "s1");
  });

  const deny = hook.beforeHandle(() => {
    throw new HttpError(401, { code: "unauthorized" });
  });

  class CookieMapController {
    ok = route({
      method: "GET",
      path: "/cm-ok",
      hooks: { beforeParse: [sessionize] },
      handler: () => ({ ok: true }),
    });

    fails = route({
      method: "GET",
      path: "/cm-fails",
      hooks: { beforeParse: [sessionize], beforeHandle: [deny] },
      handler: () => ({ ok: true }),
    });
  }

  const cookieRequest = serve(
    createApp({
      routes: new CookieMapController(),
      fallback: (ctx) => ({ hasCookieMap: ctx.req.cookies !== undefined }),
    }),
  );

  test("a cookie set through ctx.req.cookies lands on the response", async () => {
    const res = await cookieRequest("/cm-ok");

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toContain("session=s1");
  });

  test("the cookie survives an error response", async () => {
    const res = await cookieRequest("/cm-fails");

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join(";")).toContain("session=s1");
  });

  test("the 404 fallback has no cookie map — documented limitation", async () => {
    const res = await cookieRequest("/nowhere");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasCookieMap: false });
  });
});

describe("when the request was taken", () => {
  const forger = hook.beforeParse(() => ({ startedAt: 0 }));

  class TimedController {
    timed = route({
      method: "GET",
      path: "/timed",
      hooks: { beforeParse: [forger] },
      handler: (ctx) => ({
        startedAt: ctx.startedAt,
        elapsed: performance.now() - ctx.startedAt,
      }),
    });
  }

  const request = serve(createApp({ routes: new TimedController() }));

  test("ctx.startedAt is a monotonic reading taken before any hook", async () => {
    const before = performance.now();
    const res = await request("/timed");
    const after = performance.now();

    const body = (await res.json()) as { startedAt: number; elapsed: number };

    expect(body.startedAt).toBeGreaterThanOrEqual(before);
    expect(body.startedAt).toBeLessThanOrEqual(after);
    expect(body.elapsed).toBeGreaterThanOrEqual(0);
  });

  test("a hook cannot rewrite it", async () => {
    const res = await request("/timed");
    const body = (await res.json()) as { startedAt: number };

    expect(body.startedAt).toBeGreaterThan(0);
  });
});
