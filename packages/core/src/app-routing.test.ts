/**
 * Integration tests: routing edges through a live server.
 *
 * Unmatched requests (the 404/405/OPTIONS lifecycle and its interaction
 * with group hooks), CORS as an application-level hook package, route
 * precedence under Bun's router and malformed request paths.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { HttpError } from "./error.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

describe("unmatched requests", () => {
  const observed: string[] = [];

  const accessLog = hook.afterResponse((ctx) => {
    observed.push(
      `${ctx.req.method} ${new URL(ctx.req.url).pathname} ${ctx.res.status}`,
    );
  });

  const zoneGuard = hook.beforeParse(() => {
    throw new HttpError(403, { code: "zone" });
  });

  const zoneObserved: string[] = [];

  const zoneLog = hook.afterResponse((ctx) => {
    zoneObserved.push(
      `${ctx.req.method} ${new URL(ctx.req.url).pathname} ${ctx.res.status}`,
    );
  });

  class ZoneController {
    get = route({
      method: "GET",
      path: "/thing",
      handler: () => ({ ok: true }),
    });
  }

  const observedRequest = serve(
    createApp({
      hooks: { afterResponse: [accessLog] },
      routes: group("/zone", {
        hooks: { beforeParse: [zoneGuard], afterResponse: [zoneLog] },
        children: [new ZoneController()],
      }),
    }),
  );

  test("a 404 reaches application-level observers", async () => {
    observed.length = 0;

    const res = await observedRequest("/nothing/here");

    expect(res.status).toBe(404);
    expect(observed).toEqual(["GET /nothing/here 404"]);
  });

  test("a 405 reaches application-level observers", async () => {
    observed.length = 0;

    const res = await observedRequest("/zone/thing", { method: "PUT" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(observed).toEqual(["PUT /zone/thing 405"]);
  });

  test("an OPTIONS preflight reaches observers without running zone guards", async () => {
    observed.length = 0;

    const res = await observedRequest("/zone/thing", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(observed).toEqual(["OPTIONS /zone/thing 204"]);
  });

  test("zone guards still protect the routes themselves", async () => {
    const res = await observedRequest("/zone/thing");

    expect(res.status).toBe(403);
  });

  test("group hooks never see protocol responses — a documented limit", async () => {
    zoneObserved.length = 0;

    await observedRequest("/zone/thing", { method: "OPTIONS" });
    await observedRequest("/zone/thing", { method: "PUT" });
    await observedRequest("/nothing/here");

    expect(zoneObserved).toEqual([]);

    await observedRequest("/zone/thing");

    expect(zoneObserved).toEqual(["GET /zone/thing 403"]);
  });

  test("a custom fallback replaces the 404", async () => {
    const fallbackRequest = serve(
      createApp({
        routes: new ZoneController(),
        fallback: (ctx) => {
          ctx.out.status = 404;

          return { code: "no_such_route", path: new URL(ctx.req.url).pathname };
        },
      }),
    );

    const res = await fallbackRequest("/missing");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: "no_such_route",
      path: "/missing",
    });
  });
});

describe("application hooks reach every outcome", () => {
  const decorate = hook.beforeParse((ctx) => {
    ctx.out.headers.set("x-zone", "public");
  });

  const requireAuth = hook.beforeParse((ctx) => {
    if (ctx.req.headers.get("authorization") !== "token") {
      throw new HttpError(401, { code: "unauthorized" });
    }

    return { user: { id: "u1" } };
  });

  class SecureController {
    remove = route({
      method: "DELETE",
      path: "/records/:id",
      hooks: { beforeParse: [requireAuth] },
      handler: (ctx) => ({ removed: ctx.params.id, by: ctx.user.id }),
    });
  }

  const decorated = serve(
    createApp({
      hooks: { beforeParse: [decorate] },
      routes: new SecureController(),
    }),
  );

  test("a protocol response carries what an application hook set", async () => {
    const preflight = await decorated("/records/7", { method: "OPTIONS" });
    const missing = await decorated("/nothing-here");
    const wrongMethod = await decorated("/records/7", { method: "POST" });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("x-zone")).toBe("public");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-zone")).toBe("public");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("x-zone")).toBe("public");
  });

  test("so does a response the route produced", async () => {
    const res = await decorated("/records/7", {
      method: "DELETE",
      headers: { authorization: "token" },
    });

    expect(await res.json()).toEqual({ removed: "7", by: "u1" });
    expect(res.headers.get("x-zone")).toBe("public");
  });

  test("so does one a hook rejected before the route ran", async () => {
    const res = await decorated("/records/7", { method: "DELETE" });

    expect(res.status).toBe(401);
    expect(res.headers.get("x-zone")).toBe("public");
  });
});

describe("route precedence", () => {
  class PublicCatchAll {
    any = route({
      method: "GET",
      path: "/:section/:page",
      handler: () => ({ hit: "public" }),
    });
  }

  class GuardedController {
    one = route({
      method: "GET",
      path: "/:id",
      handler: () => ({ hit: "guarded" }),
    });
  }

  class OverlappingController {
    param = route({
      method: "GET",
      path: "/a/:x/b",
      handler: () => ({ hit: "param" }),
    });

    static_ = route({
      method: "GET",
      path: "/a/c/:y",
      handler: () => ({ hit: "static" }),
    });

    files = route({
      method: "GET",
      path: "/files/*",
      handler: () => ({ hit: "wildcard" }),
    });
  }

  const deny = hook.beforeParse(() => {
    throw new HttpError(403, { code: "forbidden" });
  });

  const precedenceRequest = serve(
    createApp({
      routes: [
        new PublicCatchAll(),
        group("/admin", {
          hooks: { beforeParse: [deny] },
          children: [new GuardedController()],
        }),
        new OverlappingController(),
      ],
    }),
  );

  test("a guarded group is not shadowed by an earlier catch-all", async () => {
    const res = await precedenceRequest("/admin/xyz");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden" });
  });

  test("HEAD honours the same precedence as GET", async () => {
    const res = await precedenceRequest("/admin/xyz", { method: "HEAD" });

    expect(res.status).toBe(403);
  });

  test("the catch-all still serves paths of its own", async () => {
    const res = await precedenceRequest("/blog/post1");

    expect(await res.json()).toEqual({ hit: "public" });
  });

  test("a static segment beats a parameter", async () => {
    const res = await precedenceRequest("/a/c/b");

    expect(await res.json()).toEqual({ hit: "static" });
  });

  test("wildcard paths are served", async () => {
    const res = await precedenceRequest("/files/deep/a.txt");

    expect(await res.json()).toEqual({ hit: "wildcard" });
  });
});

describe("malformed request paths", () => {
  const observed: string[] = [];

  const trace = hook.afterResponse((ctx) => {
    observed.push(new URL(ctx.req.url).pathname);
  });

  class FilesController {
    get = route({
      method: "GET",
      path: "/files/:name",
      hooks: { afterResponse: [trace] },
      handler: (ctx) => ({ name: ctx.params.name }),
    });
  }

  const filesRequest = serve(createApp({ routes: new FilesController() }));

  test("a bare percent runs the full pipeline instead of crashing", async () => {
    observed.length = 0;

    const res = await filesRequest("/files/%");

    expect(res.status).toBe(200);
    expect(observed).toEqual(["/files/%"]);
  });

  test("an invalid escape decodes to the replacement character", async () => {
    const res = await filesRequest("/files/%zz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "�" });
  });

  test("valid escapes still decode", async () => {
    const res = await filesRequest("/files/a%2Fb");

    expect(await res.json()).toEqual({ name: "a/b" });
  });

  test("a malformed path on the 404 branch does not throw either", async () => {
    const res = await filesRequest("/nope/%");

    expect(res.status).toBe(404);
  });

  test("a malformed path with a wrong method reports 405, not 500", async () => {
    const res = await filesRequest("/files/%", { method: "PATCH" });

    expect(res.status).toBe(405);
  });
});
