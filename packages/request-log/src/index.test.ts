/**
 * Tests for the request logs: the arrival line and the access line.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import {
  createApp,
  HttpError,
  hook,
  route,
  ValidationError,
} from "@tetsujs/core";
import { captureErrors, serve } from "@tetsujs/core/testing";
import { requestId } from "@tetsujs/request-id";
import type { AccessRecord, ArrivalRecord } from "./index.ts";
import { accessLog, arrivalLog } from "./index.ts";

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

const request = serve(
  createApp({
    hooks: {
      beforeParse: [tracing],
      afterResponse: [log],
    },
    routes: new ApiController(),
  }),
);

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
        hooks: { afterResponse: [alone] },
        routes: new ApiController(),
      }),
    );

    await quiet("/items");
    await Bun.sleep(20);

    expect(lines[0]).toMatchObject({
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
      "durationMs",
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

  test("needs nothing but the one hook: the core starts the clock", async () => {
    const lines: AccessRecord[] = [];
    const alone = accessLog({ write: (record) => lines.push(record) });

    const bare = serve(
      createApp({
        hooks: { afterResponse: [alone] },
        routes: new ApiController(),
      }),
    );

    await bare("/slow");
    await Bun.sleep(20);

    expect(lines[0]?.durationMs ?? 0).toBeGreaterThan(35);
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

describe("the arrival log", () => {
  const arrived: ArrivalRecord[] = [];
  const arrivals = arrivalLog({ write: (record) => arrived.push(record) });
  const stamped = requestId({ generate: () => "arrival-id" });

  let release: () => void = () => {};

  class SlowController {
    hang = route({
      method: "GET",
      path: "/hang",
      handler: () =>
        new Promise<{ done: boolean }>((resolve) => {
          release = () => resolve({ done: true });
        }),
    });

    guarded = route({
      method: "GET",
      path: "/guarded",
      hooks: {
        beforeParse: [
          hook.beforeParse(() => {
            throw new HttpError(401);
          }),
        ],
      },
      handler: () => ({ never: true }),
    });
  }

  const withId = serve(
    createApp({
      hooks: { beforeParse: [stamped, arrivals] },
      routes: new SlowController(),
    }),
  );

  const alone = serve(
    createApp({
      hooks: { beforeParse: [arrivals] },
      routes: new SlowController(),
    }),
  );

  test("a request is written while its handler still hangs", async () => {
    arrived.length = 0;

    const pending = withId("/hang?token=secret");

    for (let attempt = 0; attempt < 100 && arrived.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(arrived).toEqual([
      { method: "GET", path: "/hang", requestId: "arrival-id" },
    ]);

    release();
    expect((await pending).status).toBe(200);
  });

  test("the path keeps to the pathname: no query string", async () => {
    arrived.length = 0;

    release = () => {};
    const pending = withId("/hang?token=secret");

    for (let attempt = 0; attempt < 100 && arrived.length === 0; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(JSON.stringify(arrived)).not.toContain("secret");

    release();
    await pending;
  });

  test("a request refused by a later hook was still seen", async () => {
    arrived.length = 0;

    const res = await withId("/guarded");

    expect(res.status).toBe(401);
    expect(arrived).toEqual([
      { method: "GET", path: "/guarded", requestId: "arrival-id" },
    ]);
  });

  test("a request no route matched is seen too", async () => {
    arrived.length = 0;

    const res = await withId("/nowhere");

    expect(res.status).toBe(404);
    expect(arrived).toEqual([
      { method: "GET", path: "/nowhere", requestId: "arrival-id" },
    ]);
  });

  test("without requestId() before it, the record has no id", async () => {
    arrived.length = 0;

    await alone("/guarded");

    expect(arrived).toEqual([{ method: "GET", path: "/guarded" }]);
    expect(Object.keys(arrived[0] ?? {})).toEqual(["method", "path"]);
  });
});
