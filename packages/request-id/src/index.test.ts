/**
 * Tests for the request id hook.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Requires } from "@tetsujs/core";
import {
  createApp,
  HttpError,
  hook,
  route,
  ValidationError,
} from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { requestId } from "./index.ts";

const tracing = requestId({ generate: () => "generated-id" });

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
    hooks: { beforeParse: [tracing] },
    handler: (ctx) => ({ seenByHandler: ctx.requestId }),
  });
}

const request = serve(
  createApp({
    hooks: { beforeParse: [tracing] },
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
        hooks: { beforeParse: [trusting] },
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
        hooks: { beforeParse: [trusting] },
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
        hooks: { beforeParse: [custom] },
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
        hooks: { beforeParse: [real] },
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

describe("the id deeper than the handler", () => {
  const store = new AsyncLocalStorage<{ requestId: string }>();

  /** The README's recipe, as written there. */
  const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
    store.enterWith({ requestId: ctx.requestId });
  });

  const current = () => store.getStore();

  /** A service several calls down, which never sees `ctx`. */
  const service = () => current()?.requestId ?? null;

  class DeepController {
    read = route({
      method: "GET",
      path: "/deep",
      handler: () => ({ seenByService: service() }),
    });
  }

  const request = serve(
    createApp({
      hooks: { beforeParse: [requestId(), scope] },
      fallback: (ctx) => {
        ctx.out.status = 404;

        return { seenByService: service() };
      },
      routes: new DeepController(),
    }),
  );

  test("mounted on the application, reaches a service without ctx", async () => {
    const res = await request("/deep");

    expect(await res.json()).toEqual({
      seenByService: res.headers.get("x-request-id"),
    });
  });

  test("covers a request no route matched", async () => {
    const res = await request("/nowhere");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      seenByService: res.headers.get("x-request-id"),
    });
  });
});
