/**
 * Integration tests: a body the framework hands over unread.
 *
 * `bodyType: "stream"` is the declaration that makes the escape hatch an
 * announcement — and, unlike the escape hatch, it keeps the limit. The
 * bytes are counted on their way past without ever being buffered, so the
 * route that streams a large upload is still bounded.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { route } from "./route.ts";

const kib = 1024;

const drained: string[] = [];

class UploadController {
  /** Reads the stream and reports what it counted. */
  upload = route({
    method: "POST",
    path: "/upload",
    bodyType: "stream",
    handler: async (ctx) => {
      let seen = 0;

      for await (const chunk of ctx.body) {
        seen += chunk.byteLength;
      }

      return { seen };
    },
  });

  /** The same, with a ceiling of its own. */
  big = route({
    method: "POST",
    path: "/big",
    bodyType: "stream",
    maxBodySize: 512 * kib,
    handler: async (ctx) => {
      let seen = 0;

      for await (const chunk of ctx.body) {
        seen += chunk.byteLength;
      }

      return { seen };
    },
  });

  /** Cleans up after itself when the limit ends the stream mid-read. */
  partial = route({
    method: "POST",
    path: "/partial",
    bodyType: "stream",
    handler: async (ctx) => {
      try {
        for await (const _chunk of ctx.body) {
          // written somewhere else, in a real one
        }
      } finally {
        drained.push("cleaned up");
      }

      return { ok: true };
    },
  });
}

const request = serve(
  createApp({ maxBodySize: 64 * kib, routes: new UploadController() }),
);

describe("a body handed over unread", () => {
  test("arrives as a stream the handler drains itself", async () => {
    const res = await request("/upload", {
      method: "POST",
      body: "x".repeat(32 * kib),
    });

    expect(await res.json()).toEqual({ seen: 32 * kib });
  });

  test("a request with no body reads as an empty one", async () => {
    const res = await request("/upload", { method: "POST" });

    // Nothing to ask about: a handler that loops over it loops zero times
    // rather than checking whether there was a body at all.
    expect(await res.json()).toEqual({ seen: 0 });
  });

  test("is still held to the limit, with the ordinary envelope", async () => {
    const res = await request("/upload", {
      method: "POST",
      body: "x".repeat(200 * kib),
    });

    // The escape hatch — declaring nothing and reading `ctx.req.body` —
    // loses this. Declaring the shape keeps it.
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      status: 413,
      message: "Body exceeds the configured limit",
      error: "BODY_TOO_LARGE",
    });
  });

  test("the handler's cleanup runs when the limit cuts it short", async () => {
    drained.length = 0;

    await request("/partial", { method: "POST", body: "x".repeat(200 * kib) });

    // The limit fires while the handler is running, so undoing a partial
    // upload is its own business — and it gets the chance.
    expect(drained).toEqual(["cleaned up"]);
  });
});

describe("a ceiling on the route", () => {
  test("overrides the application's, upwards", async () => {
    const res = await request("/big", {
      method: "POST",
      body: "x".repeat(400 * kib),
    });

    // Six times what the application allows, because this route said so.
    expect(await res.json()).toEqual({ seen: 400 * kib });
  });

  test("and still ends at its own", async () => {
    const res = await request("/big", {
      method: "POST",
      body: "x".repeat(600 * kib),
    });

    expect(res.status).toBe(413);
  });

  test("raises Bun's cap when it is the largest thing in the application", () => {
    const huge = createApp({
      maxBodySize: 1024,
      routes: {
        vast: route({
          method: "POST",
          path: "/vast",
          bodyType: "stream",
          maxBodySize: 200 * 1024 * 1024,
          handler: () => ({ ok: true }),
        }),
      },
    });

    // The application allows a kilobyte; one route allows two hundred
    // megabytes, and Bun would have cut it at its own default.
    expect(huge.maxRequestBodySize).toBeGreaterThan(200 * 1024 * 1024);
  });
});

describe("a route that waits for nothing", () => {
  const app = createApp({
    routes: {
      plain: route({
        method: "GET",
        path: "/plain",
        handler: () => ({ ok: true }),
      }),
      echo: route({
        method: "POST",
        path: "/echo",
        bodyType: "stream",
        handler: (ctx) => new Response(ctx.body),
      }),
    },
  });

  /** Calls a path's native handler directly, as Bun's router would. */
  function call(path: string, init?: RequestInit) {
    const req = Object.assign(new Request(`http://local${path}`, init), {
      params: {},
    });

    return app.routes[path]?.(req as never, {} as never);
  }

  test("answers without a promise", () => {
    expect(call("/plain")).toBeInstanceOf(Response);
  });

  test("answers without a promise when its body is a stream", async () => {
    const res = call("/echo", { method: "POST", body: "hello" });

    // Counting a stream is wrapping it, not waiting on it: the parse stage
    // has nothing to await, so the pipeline does not turn asynchronous.
    expect(res).toBeInstanceOf(Response);
    expect(await (res as Response).text()).toBe("hello");
  });
});
