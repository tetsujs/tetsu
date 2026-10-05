/**
 * Tests for Bun's idle timeout, and the stream that has to outlast it.
 *
 * Bun closes a connection that sends nothing for its `idleTimeout`, 10
 * seconds by default, and a quiet feed sends its first heartbeat after
 * 15: every `sse()` that had nothing to say was cut before it. A stream
 * with a keep-alive now raises its own request's timeout above the
 * interval — and only that stream, and only once it is read.
 *
 * These go through `Bun.serve` directly rather than `serve()`, for the
 * server's `idleTimeout` and for its `timeout()`, which a spy watches.
 *
 * @module
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { sse, stream } from "./index.ts";

/** Settles when the stream is over — what a quiet source waits on. */
function until(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A feed with nothing to say: only the end of the stream ends it. */
// biome-ignore lint/correctness/useYield: it waits instead.
async function* quiet(signal: AbortSignal) {
  await until(signal);
}

const app = createApp({
  routes: {
    feed: route({
      method: "GET",
      path: "/feed",
      handler: (ctx) => sse(ctx, quiet),
    }),
    beating: route({
      method: "GET",
      path: "/beating",
      handler: (ctx) => sse(ctx, quiet, { heartbeatMs: 5_000 }),
    }),
    rare: route({
      method: "GET",
      path: "/rare",
      handler: (ctx) => sse(ctx, quiet, { heartbeatMs: 600_000 }),
    }),
    silent: route({
      method: "GET",
      path: "/silent",
      handler: (ctx) => sse(ctx, quiet, { heartbeatMs: 0 }),
    }),
    drained: route({
      method: "GET",
      path: "/drained",
      handler: (ctx) => sse(ctx, quiet, { until: AbortSignal.abort() }),
    }),
    rows: route({
      method: "GET",
      path: "/rows",
      handler: (ctx) =>
        stream(
          ctx,
          async function* (signal) {
            yield "row\n";

            await until(signal);
          },
          { keepAlive: { everyMs: 2_500, chunk: "\n" } },
        ),
    }),
    plain: route({
      method: "GET",
      path: "/plain",
      handler: (ctx) =>
        stream(ctx, async function* (signal) {
          yield "row\n";

          await until(signal);
        }),
    }),
  },
});

// Bun checks idleness every four seconds, so a timeout of one second ends
// a connection at the next check: within four seconds, whatever it sends.
const strict = Bun.serve({ ...app, port: 0, idleTimeout: 1 });

const watched = Bun.serve({ ...app, port: 0 });
const timeouts = spyOn(watched, "timeout");

afterAll(() => {
  void strict.stop(true);
  void watched.stop(true);
});

/**
 * Opens a stream on the watched server, reads its first chunk, waits for
 * the stream to have started, and leaves. Returns the timeouts set.
 */
async function timeoutsSetBy(path: string) {
  timeouts.mockClear();

  const controller = new AbortController();
  const res = await fetch(new URL(path, watched.url), {
    signal: controller.signal,
  });

  await res.body?.getReader().read();
  await Bun.sleep(20);

  controller.abort();

  return timeouts.mock.calls.map(([req, seconds]) => [
    new URL(req.url).pathname,
    seconds,
  ]);
}

describe("a quiet feed", () => {
  test("outlives the server's idle timeout, to its next heartbeat", async () => {
    const controller = new AbortController();
    const res = await fetch(new URL("/beating", strict.url), {
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();

    const opening = await reader?.read();
    const beat = await reader?.read();

    expect(decoder.decode(opening?.value)).toBe(": open\n\n");
    expect(decoder.decode(beat?.value)).toBe(": ping\n\n");

    controller.abort();
  }, 10_000);
});

describe("the request's own timeout", () => {
  test("is the heartbeat and ten seconds more, set when the stream is read", async () => {
    expect(await timeoutsSetBy("/feed")).toEqual([["/feed", 25]]);
  });

  test("follows a keep-alive of stream() too, rounded up to a second", async () => {
    expect(await timeoutsSetBy("/rows")).toEqual([["/rows", 13]]);
  });

  test("is at most the 255 seconds Bun takes", async () => {
    expect(await timeoutsSetBy("/rare")).toEqual([["/rare", 255]]);
  });
});

describe("the server's timeout is left alone", () => {
  test("by a feed without a heartbeat", async () => {
    expect(await timeoutsSetBy("/silent")).toEqual([]);
  });

  test("by a stream() without a keep-alive", async () => {
    expect(await timeoutsSetBy("/plain")).toEqual([]);
  });

  test("by a stream ended before it was read, as on draining", async () => {
    expect(await timeoutsSetBy("/drained")).toEqual([]);
  });

  test("by a stream nobody reads, such as the answer to HEAD", async () => {
    timeouts.mockClear();

    const res = await fetch(new URL("/feed", watched.url), { method: "HEAD" });

    await Bun.sleep(20);

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(timeouts.mock.calls).toEqual([]);
  });
});
