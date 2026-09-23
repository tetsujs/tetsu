/**
 * Integration tests: streamed responses through a live server.
 *
 * A handler that returns a `Response` carrying a stream is returning a raw
 * response like any other — the pipeline must hand it over untouched, and
 * everything that decorates responses must decorate it without draining
 * it. None of that required code; all of it required proof.
 *
 * The other half is what happens to a stream handed over *without* that
 * response. It serializes to `{}` like any object with no own enumerable
 * properties, so the endpoint would answer `200` with an empty body and
 * say nothing — the refusal below is what makes that impossible. The
 * handlers here annotate their return as `unknown` on purpose: `route()`
 * rejects an inferred stream at compile time, and these tests are about
 * the values types cannot see — what arrives from untyped code, from
 * `any`, from a library.
 *
 * The third part is the stream that never leaves: a response the pipeline
 * built and then threw away — replaced by a hook, displaced by an error,
 * answered without a body for `HEAD` — is nobody else's to collect, so the
 * tests below assert that its body is cancelled, and that a body living on
 * inside the replacement is not.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { captureErrors } from "../test-utils/logs.ts";
import { serve } from "../test-utils/server.ts";
import { createApp } from "./app.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

const encoder = new TextEncoder();

/** Emits `count` chunks, stopping early when the client goes away. */
function ticks(count: number, signal: AbortSignal, onAbort?: () => void) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let index = 0; index < count; index += 1) {
        if (signal.aborted) {
          onAbort?.();
          controller.close();

          return;
        }

        controller.enqueue(encoder.encode(`chunk ${index}\n`));

        await Bun.sleep(15);
      }

      controller.close();
    },
  });
}

const abandoned: string[] = [];
const observed: number[] = [];

const decorate = hook.beforeResponse((ctx) => {
  ctx.out.headers.set("x-decorated", "yes");
});

const observe = hook.afterResponse((ctx) => {
  observed.push(ctx.res.status);
});

class StreamController {
  short = route({
    method: "GET",
    path: "/stream",
    hooks: { beforeResponse: [decorate], afterResponse: [observe] },
    handler: (ctx) =>
      new Response(ticks(3, ctx.req.signal), {
        headers: { "content-type": "text/plain" },
      }),
  });

  endless = route({
    method: "GET",
    path: "/endless",
    handler: (ctx) =>
      new Response(
        ticks(1_000, ctx.req.signal, () => {
          abandoned.push("stopped");
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  });
}

const request = serve(createApp({ routes: new StreamController() }));

/** A second application, proxying the first — its responses are immutable. */
class ProxyController {
  through = route({
    method: "GET",
    path: "/proxied",
    hooks: { beforeResponse: [decorate] },
    handler: () => fetch(new URL("/stream", request.url).href),
  });
}

const proxy = serve(createApp({ routes: new ProxyController() }));

describe("a streamed response", () => {
  test("arrives chunk by chunk, in order", async () => {
    const res = await request("/stream");

    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("chunk 0\nchunk 1\nchunk 2\n");
  });

  test("is not buffered before the client sees it", async () => {
    const started = Date.now();
    const res = await request("/stream");
    const reader = res.body?.getReader();

    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toBe("chunk 0\n");
    expect(Date.now() - started).toBeLessThan(40);

    await reader?.cancel();
  });

  test("carries the headers a hook set on it", async () => {
    const res = await request("/stream");

    expect(res.headers.get("x-decorated")).toBe("yes");

    await res.body?.cancel();
  });

  test("survives a response whose headers cannot be mutated", async () => {
    const res = await proxy("/proxied");

    expect(res.headers.get("x-decorated")).toBe("yes");
    expect(await res.text()).toBe("chunk 0\nchunk 1\nchunk 2\n");
  });
});

describe("the client leaving", () => {
  test("reaches the handler through the request's signal", async () => {
    abandoned.length = 0;

    const controller = new AbortController();

    const res = await fetch(new URL("/endless", request.url).href, {
      signal: controller.signal,
    });

    const reader = res.body?.getReader();

    await reader?.read();

    controller.abort();

    await Bun.sleep(80);

    expect(abandoned).toEqual(["stopped"]);
  });
});

describe("observation", () => {
  test("afterResponse runs when the response is handed over, not when the stream ends", async () => {
    observed.length = 0;

    const res = await request("/stream");
    const reader = res.body?.getReader();

    await reader?.read();
    await Bun.sleep(10);

    expect(observed).toEqual([200]);

    await reader?.cancel();
  });
});

const released: string[] = [];

/**
 * A stream that records its own release.
 *
 * An `open` one never ends on its own, which is what a subscription looks
 * like from out here: the only thing that can end it is someone saying the
 * body is not wanted.
 */
function held(label: string, open: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${label}\n`));

      if (!open) {
        controller.close();
      }
    },

    cancel() {
      released.push(label);
    },
  });
}

/** Replaces the response outright — the stream behind it is dropped. */
const replace = hook.beforeResponse(() => new Response("replaced"));

/** Rebuilds the response around the body it was given — the same stream. */
const rebuild = hook.beforeResponse(
  (ctx) =>
    new Response(ctx.res.body, { status: 201, headers: ctx.res.headers }),
);

class DiscardController {
  replaced = route({
    method: "GET",
    path: "/replaced",
    hooks: { beforeResponse: [replace] },
    handler: () =>
      new Response(held("replaced", true), {
        headers: { "content-type": "text/plain" },
      }),
  });

  failed = route({
    method: "GET",
    path: "/failed",
    hooks: {
      beforeResponse: [
        hook.beforeResponse(() => {
          throw new Error("hook failed");
        }),
      ],
    },
    handler: () =>
      new Response(held("failed", true), {
        headers: { "content-type": "text/plain" },
      }),
  });

  streamed = route({
    method: "GET",
    path: "/streamed",
    handler: () =>
      new Response(held("head", true), {
        headers: { "content-type": "text/plain" },
      }),
  });

  /**
   * A hook that takes a reader on the body and keeps it. The pipeline
   * cannot cancel what is locked, and the rejection that says so must not
   * escape: under `bun test` an unhandled one fails whichever test is
   * running, which is what gives the test below its detecting power.
   */
  locked = route({
    method: "GET",
    path: "/locked",
    hooks: {
      beforeResponse: [
        hook.beforeResponse((ctx) => {
          ctx.res.body?.getReader();

          return new Response("replaced");
        }),
      ],
    },
    handler: () =>
      new Response(held("locked", true), {
        headers: { "content-type": "text/plain" },
      }),
  });

  rebuilt = route({
    method: "GET",
    path: "/rebuilt",
    hooks: { beforeResponse: [rebuild] },
    handler: () =>
      new Response(held("rebuilt", false), {
        headers: { "content-type": "text/plain" },
      }),
  });
}

const discard = serve(createApp({ routes: new DiscardController() }));

describe("a body that is already someone else's", () => {
  test("answers as usual, and failing to cancel it stays quiet", async () => {
    released.length = 0;

    const res = await discard("/locked");

    expect(await res.text()).toBe("replaced");
    expect(released).toEqual([]);

    await Bun.sleep(10);
  });
});

describe("a HEAD request over a streaming route", () => {
  test("releases the body it answers without", async () => {
    released.length = 0;

    const res = await discard("/streamed", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(released).toEqual(["head"]);
  });
});

describe("a response the error path discards", () => {
  const errors = captureErrors();

  test("releases the body the mapped error response displaces", async () => {
    released.length = 0;

    const res = await discard("/failed");

    expect(res.status).toBe(500);
    expect(released).toEqual(["failed"]);
    expect(errors.lines.join("\n")).toContain("[tetsu] Unhandled error");
  });
});

describe("a response the pipeline discards", () => {
  test("releases the body of the response a hook replaced", async () => {
    released.length = 0;

    const res = await discard("/replaced");

    expect(await res.text()).toBe("replaced");
    expect(released).toEqual(["replaced"]);
  });

  test("leaves the body alone when the replacement carries it", async () => {
    released.length = 0;

    const res = await discard("/rebuilt");

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("rebuilt\n");
    expect(released).toEqual([]);
  });
});

/** Handlers that answer with a stream and no response to carry it. */
class BareController {
  stream = route({
    method: "GET",
    path: "/bare-stream",
    handler: (): unknown =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("chunk 0\n"));
          controller.close();
        },
      }),
  });

  asyncGenerator = route({
    method: "GET",
    path: "/bare-async-generator",
    handler: (): unknown =>
      (async function* () {
        yield "one";
      })(),
  });

  generator = route({
    method: "GET",
    path: "/bare-generator",
    handler: (): unknown =>
      (function* () {
        yield "one";
      })(),
  });

  list = route({
    method: "GET",
    path: "/list",
    handler: (): unknown => [1, 2, 3],
  });
}

const bare = serve(createApp({ routes: new BareController() }));

describe("a stream returned without a response to carry it", () => {
  const errors = captureErrors();

  test("is refused rather than serialized to an empty object", async () => {
    const res = await bare("/bare-stream");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
      error: "INTERNAL_SERVER_ERROR",
    });
    expect(errors.lines.join("\n")).toContain("ReadableStream");
  });

  test("names the wrapper the handler should have used", async () => {
    await bare("/bare-stream");

    expect(errors.lines.join("\n")).toContain("new Response(stream");
  });

  test("is refused for an async generator too", async () => {
    const res = await bare("/bare-async-generator");

    expect(res.status).toBe(500);
    expect(errors.lines.join("\n")).toContain("async iterable");
  });

  test("is refused for a synchronous generator, which fails just as quietly", async () => {
    const res = await bare("/bare-generator");

    expect(res.status).toBe(500);
    expect(errors.lines.join("\n")).toContain("generator");
  });

  test("leaves an ordinary iterable alone", async () => {
    const res = await bare("/list");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([1, 2, 3]);
    expect(errors.lines).toEqual([]);
  });
});
