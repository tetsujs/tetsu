/**
 * Tests for the request id and access log hooks.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, HttpError, route, ValidationError } from "@tetsujs/core";
import { captureErrors, serve } from "@tetsujs/core/testing";
import type { AccessRecord } from "./index.ts";
import { accessLog, requestId } from "./index.ts";

const written: AccessRecord[] = [];

const tracing = requestId({ generate: () => "generated-id" });
const log = accessLog({ write: (record) => written.push(record) });

class ApiController {
  read = route({
    method: "GET",
    path: "/items",
    handler: (ctx) => ({
      seenByHandler: (ctx as { requestId?: string }).requestId ?? null,
    }),
  });

  show = route({
    method: "GET",
    path: "/items/:id",
    handler: (ctx) => ({ id: ctx.params.id }),
  });

  fails = route({
    method: "GET",
    path: "/fails",
    handler: () => {
      throw new HttpError(418, { code: "teapot" });
    },
  });

  rejects = route({
    method: "GET",
    path: "/rejects",
    handler: () => {
      throw new ValidationError(422, [
        { path: ["id"], message: "expected a number" },
      ]);
    },
  });

  leaks = route({
    method: "GET",
    path: "/leaks",
    handler: () => {
      throw new TypeError("authorization=Bearer super-secret-token");
    },
  });

  slow = route({
    method: "GET",
    path: "/slow",
    handler: async () => {
      await Bun.sleep(40);

      return { ok: true };
    },
  });
}

/**
 * The same hook mounted on the route rather than on the application: only
 * there can it type the handler, because only there is the route known.
 */
class TypedController {
  read = route({
    method: "GET",
    path: "/items",
    hooks: { beforeParse: [...tracing.beforeParse] },
    handler: (ctx) => ({ seenByHandler: ctx.requestId }),
  });
}

const request = serve(
  createApp({
    hooks: {
      beforeParse: [...tracing.beforeParse, ...log.beforeParse],
      afterResponse: [...log.afterResponse],
    },
    routes: new ApiController(),
  }),
);

const typedOnTheRoute = serve(createApp({ routes: new TypedController() }));

describe("the request id", () => {
  test("reaches the handler and the response", async () => {
    const res = await typedOnTheRoute("/items");

    expect(res.headers.get("x-request-id")).toBe("generated-id");
    expect(await res.json()).toEqual({ seenByHandler: "generated-id" });
  });

  test("an application-wide one still reaches the handler at runtime", async () => {
    const res = await request("/items");

    expect(await res.json()).toEqual({ seenByHandler: "generated-id" });
  });

  test("is on an error response too", async () => {
    const res = await request("/fails");

    expect(res.status).toBe(418);
    expect(res.headers.get("x-request-id")).toBe("generated-id");
  });

  test("ignores what the client sent, by default", async () => {
    const res = await request("/items", {
      headers: { "x-request-id": "chosen-by-the-client" },
    });

    expect(res.headers.get("x-request-id")).toBe("generated-id");
  });

  test("takes an incoming one when it is trusted", async () => {
    const trusting = requestId({
      trustIncoming: true,
      generate: () => "generated-id",
    });

    const behindProxy = serve(
      createApp({
        hooks: { beforeParse: [...trusting.beforeParse] },
        routes: new ApiController(),
      }),
    );

    const res = await behindProxy("/items", {
      headers: { "x-request-id": "from-the-proxy" },
    });

    expect(res.headers.get("x-request-id")).toBe("from-the-proxy");
  });

  test("makes its own when a trusted header came empty", async () => {
    const trusting = requestId({
      trustIncoming: true,
      generate: () => "generated-id",
    });

    const behindProxy = serve(
      createApp({
        hooks: { beforeParse: [...trusting.beforeParse] },
        routes: new ApiController(),
      }),
    );

    // `Headers` trims, so a header of spaces arrives as "" too: either way
    // there is no id in it, and a log line with an empty one correlates
    // with nothing.
    for (const sent of ["", "   "]) {
      const res = await behindProxy("/items", {
        headers: { "x-request-id": sent },
      });

      expect(res.headers.get("x-request-id")).toBe("generated-id");
    }
  });

  test("uses the header it was told to", async () => {
    const custom = requestId({
      header: "x-correlation-id",
      generate: () => "generated-id",
    });

    const correlated = serve(
      createApp({
        hooks: { beforeParse: [...custom.beforeParse] },
        routes: new ApiController(),
      }),
    );

    const res = await correlated("/items");

    expect(res.headers.get("x-correlation-id")).toBe("generated-id");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  test("is a fresh uuid without a generator", async () => {
    const real = requestId();

    const plain = serve(
      createApp({
        hooks: { beforeParse: [...real.beforeParse] },
        routes: new ApiController(),
      }),
    );

    const first = await plain("/items");
    const second = await plain("/items");

    expect(first.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
    expect(first.headers.get("x-request-id")).not.toBe(
      second.headers.get("x-request-id"),
    );
  });
});

describe("the access log", () => {
  test("writes one record per finished request", async () => {
    written.length = 0;

    await request("/items");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({
      method: "GET",
      path: "/items",
      route: "/items",
      status: 200,
      requestId: "generated-id",
    });
    expect(written).toHaveLength(1);
  });

  test("writes failures too", async () => {
    written.length = 0;

    await request("/fails");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({ path: "/fails", status: 418 });
  });

  test("writes a 404 the routes never saw, with no route to name", async () => {
    written.length = 0;

    await request("/nothing-here");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({ path: "/nothing-here", status: 404 });
    expect(written[0]).not.toHaveProperty("route");
  });

  test("names the route as declared, not as the client spelled it", async () => {
    written.length = 0;

    await request("/items/7");
    await Bun.sleep(20);

    // The whole point of the field: a dashboard grouping by `path` grows a
    // series per identifier, where `route` has one per endpoint.
    expect(written[0]).toMatchObject({
      path: "/items/7",
      route: "/items/:id",
    });
  });

  test("works without the id hook, leaving the field out", async () => {
    const lines: AccessRecord[] = [];
    const alone = accessLog({ write: (record) => lines.push(record) });

    const quiet = serve(
      createApp({
        hooks: { afterResponse: [...alone.afterResponse] },
        routes: new ApiController(),
      }),
    );

    await quiet("/items");
    await Bun.sleep(20);

    expect(lines[0]).toEqual({
      method: "GET",
      path: "/items",
      route: "/items",
      status: 200,
    });
    expect(Object.keys(lines[0] ?? {})).toEqual([
      "method",
      "path",
      "route",
      "status",
    ]);
  });
});

describe("how long it took", () => {
  test("is on the record, and is a real measurement", async () => {
    written.length = 0;

    await request("/slow");
    await Bun.sleep(20);

    const duration = written[0]?.durationMs ?? 0;

    // The handler sleeps 40 ms, so anything far below it means the clock is
    // being read twice in the same place rather than around the request.
    expect(duration).toBeGreaterThan(35);
    expect(duration).toBeLessThan(500);
  });

  test("is absent when only the observing half is mounted", async () => {
    const lines: AccessRecord[] = [];
    const halved = accessLog({ write: (record) => lines.push(record) });

    const partial = serve(
      createApp({
        hooks: { afterResponse: [...halved.afterResponse] },
        routes: new ApiController(),
      }),
    );

    await partial("/items");
    await Bun.sleep(20);

    // Nothing started the clock, and the record says so by leaving the
    // field out rather than reporting a zero.
    expect(lines[0]).not.toHaveProperty("durationMs");
  });
});

describe("what failed", () => {
  const errors = captureErrors();

  test("names a deliberate refusal", async () => {
    written.length = 0;

    await request("/fails");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({ status: 418, thrown: "HttpError" });
  });

  test("names the subclass a validation failure throws", async () => {
    written.length = 0;

    await request("/rejects");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({
      status: 422,
      thrown: "ValidationError",
    });
  });

  test("names a bug as the bug it is", async () => {
    written.length = 0;

    await request("/leaks");
    await Bun.sleep(20);

    expect(written[0]).toMatchObject({ status: 500, thrown: "TypeError" });
  });

  test("says nothing about a request that did not fail", async () => {
    written.length = 0;

    await request("/items");
    await Bun.sleep(20);

    expect(written[0]).not.toHaveProperty("thrown");
  });

  test("never carries the message, so a secret in one cannot reach the log", async () => {
    written.length = 0;

    await request("/leaks");
    await Bun.sleep(20);

    // The handler throws a message holding a credential. The record is what
    // gets shipped to a log store, and nothing in it may quote the value.
    expect(JSON.stringify(written[0])).not.toContain("super-secret-token");
    expect(JSON.stringify(written[0])).not.toContain("authorization");

    // The other half of the same decision: the operator loses nothing,
    // because the framework prints the whole error where it always did.
    expect(errors.lines.join("\n")).toContain("super-secret-token");
  });
});
