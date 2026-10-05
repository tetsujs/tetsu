/**
 * Tests for how long a stream holds on to things: until a signal from
 * outside ends it, and a keep-alive only for a stream somebody reads.
 *
 * `server.stop()` waits for every request in flight, and an event stream
 * is always in flight: with nothing to end it, a deploy waited out the
 * whole grace period and exited as a forced stop. `until` is what ends it
 * — `draining` from `@tetsujs/lifecycle`, in practice.
 *
 * @module
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { serve, testCtx } from "@tetsujs/core/testing";
import type { Server } from "bun";
import type { SseSummary } from "./index.ts";
import { frame, sse, stream } from "./index.ts";

const summaries: SseSummary[] = [];
const cleaned: string[] = [];
const until = { controller: new AbortController() };

const request = serve(
  createApp({
    routes: {
      feed: route({
        method: "GET",
        path: "/feed",
        handler: (ctx) =>
          sse(
            ctx,
            async function* (signal) {
              try {
                yield { data: "first" };

                await new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
              } finally {
                cleaned.push("feed closed");
              }
            },
            {
              heartbeatMs: 0,
              until: until.controller.signal,
              onEnd: (summary) => summaries.push(summary),
            },
          ),
      }),
      deaf: route({
        method: "GET",
        path: "/deaf",
        handler: (ctx) =>
          sse(
            ctx,
            async function* () {
              yield { data: "first" };

              // Waits on something other than the signal.
              await new Promise<void>(() => {});
            },
            { heartbeatMs: 0, until: until.controller.signal },
          ),
      }),
      rows: route({
        method: "GET",
        path: "/rows",
        handler: (ctx) =>
          stream(
            ctx,
            async function* () {
              yield "row\n";

              await new Promise<void>(() => {});
            },
            { until: until.controller.signal },
          ),
      }),
    },
  }),
);

/** Reads a body to its end, giving up after a while. */
async function readAll(res: Response, ms = 1_000): Promise<string | "open"> {
  const text = res.text();
  const timeout = Bun.sleep(ms).then(() => "open" as const);

  return Promise.race([text, timeout]);
}

describe("a stream ended from outside", () => {
  test("ends when until fires, and its source unwinds", async () => {
    until.controller = new AbortController();
    summaries.length = 0;
    cleaned.length = 0;

    const res = await request("/feed");

    setTimeout(() => until.controller.abort(), 50);

    expect(await readAll(res)).toBe(": open\n\ndata: first\n\n");

    await Bun.sleep(20);

    expect(cleaned).toEqual(["feed closed"]);
    expect(summaries.map((summary) => summary.reason)).toEqual(["cancelled"]);
  });

  test("ends even when its source waits on something else", async () => {
    until.controller = new AbortController();

    const res = await request("/deaf");

    setTimeout(() => until.controller.abort(), 50);

    expect(await readAll(res)).toBe(": open\n\ndata: first\n\n");
  });

  test("so does a stream() of another format", async () => {
    until.controller = new AbortController();

    const res = await request("/rows");

    setTimeout(() => until.controller.abort(), 50);

    expect(await readAll(res)).toBe("row\n");
  });

  test("a stream made after it fired ends at once", async () => {
    until.controller = new AbortController();
    until.controller.abort();

    expect(await readAll(await request("/feed"))).toBe(": open\n\n");
  });
});

describe("the keep-alive", () => {
  test("does not start for a stream nobody reads", async () => {
    const timers = spyOn(globalThis, "setInterval");
    const before = timers.mock.calls.length;

    // A handler that made its stream and then threw: the response never
    // leaves, and nobody will read or cancel it.
    sse(
      testCtx({}),
      async function* () {
        yield { data: "never" };
      },
      { heartbeatMs: 10 },
    );

    await Bun.sleep(30);

    expect(timers.mock.calls.length).toBe(before);

    timers.mockRestore();
  });

  test("starts once the stream is read", async () => {
    const timers = spyOn(globalThis, "setInterval");
    const before = timers.mock.calls.length;

    const res = sse(
      testCtx({}),
      async function* () {
        yield { data: "one" };
      },
      { heartbeatMs: 10 },
    );

    const reader = res.body?.getReader();

    await reader?.read();
    await reader?.read();

    expect(timers.mock.calls.length).toBe(before + 1);

    await reader?.cancel();
    timers.mockRestore();
  });

  test("does not start on an interval of 0, which turns it off", async () => {
    const timers = spyOn(globalThis, "setInterval");
    const before = timers.mock.calls.length;

    const res = stream(
      testCtx({}),
      async function* () {
        yield "one\n";
      },
      { keepAlive: { everyMs: 0, chunk: "\n" } },
    );

    expect(await readAll(res)).toBe("one\n");
    expect(timers.mock.calls.length).toBe(before);

    timers.mockRestore();
  });
});

// `Number()` of an unset variable is NaN, which read as off let Bun close a
// quiet feed, and a timer runs a delay it cannot hold every millisecond.
describe("a server that cannot take a timeout", () => {
  // A context built by hand, or `testCtx()` from before 0.6.2, has a server
  // whose `timeout()` is missing or throws. 0.6.1 read these streams fine.
  test("leaves a stream with a keep-alive as it was", async () => {
    const ended: SseSummary[] = [];
    const ctx = { ...testCtx({}), server: {} as Server<unknown> };

    const res = sse(
      ctx,
      async function* () {
        yield { data: "one" };
      },
      { heartbeatMs: 1_000, onEnd: (summary) => ended.push(summary) },
    );

    expect(await readAll(res)).toBe(": open\n\ndata: one\n\n");
    expect(ended.map((summary) => summary.reason)).toEqual(["ended"]);
  });
});

describe("a heartbeat that is not a number", () => {
  // Read from a JSON file, say: 0.6.1 took "50" as fifty milliseconds.
  test("is refused with its type named, and no word about NaN", () => {
    const make = () =>
      sse(
        testCtx({}),
        async function* () {
          yield { data: "never" };
        },
        { heartbeatMs: "50" as unknown as number },
      );

    expect(make).toThrow('not the string "50"');
    expect(make).not.toThrow("NaN");
  });

  test("while NaN is told where it most likely came from", () => {
    const make = () =>
      sse(
        testCtx({}),
        async function* () {
          yield { data: "never" };
        },
        { heartbeatMs: Number.NaN },
      );

    expect(make).toThrow("Number() of a variable that is not set is NaN");
  });
});

describe("an interval no timer holds", () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 31])(
    "%p is refused as a heartbeat, where the stream is made",
    (heartbeatMs) => {
      const make = () =>
        sse(
          testCtx({}),
          async function* () {
            yield { data: "never" };
          },
          { heartbeatMs },
        );

      expect(make).toThrow(TypeError);
      expect(make).toThrow("an SSE heartbeatMs must be 0");
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 31])(
    "%p is refused as the keep-alive of stream()",
    (everyMs) => {
      const make = () =>
        stream(
          testCtx({}),
          async function* () {
            yield "never\n";
          },
          { keepAlive: { everyMs, chunk: "\n" } },
        );

      expect(make).toThrow(TypeError);
      expect(make).toThrow("a keep-alive's everyMs must be 0");
    },
  );
});

describe("a stream nobody sent", () => {
  test("a stream() starts neither its source nor its keep-alive", async () => {
    const timers = spyOn(globalThis, "setInterval");
    const before = timers.mock.calls.length;
    let started = false;

    stream(
      testCtx({}),
      async function* () {
        started = true;

        yield "never\n";
      },
      { keepAlive: { everyMs: 10, chunk: "\n" } },
    );

    await Bun.sleep(30);

    expect(started).toBe(false);
    expect(timers.mock.calls.length).toBe(before);

    timers.mockRestore();
  });

  test("does not wait on until, and reports nothing when it fires", async () => {
    const draining = new AbortController();
    const ended: SseSummary[] = [];

    sse(
      testCtx({}),
      async function* () {
        yield { data: "never" };
      },
      { until: draining.signal, onEnd: (summary) => ended.push(summary) },
    );

    draining.abort();

    await Bun.sleep(10);

    expect(ended).toEqual([]);
  });
});

describe("retry", () => {
  test.each([Number.NaN, -5, 1.5, Number.POSITIVE_INFINITY, 1e21])(
    "%p is refused, as a browser would silently ignore it",
    (retry) => {
      expect(() => frame({ data: "x", retry })).toThrow(/retry/);
    },
  );

  test("a whole number of milliseconds goes out", () => {
    expect(frame({ data: "x", retry: 0 })).toBe("retry: 0\ndata: x\n\n");
    expect(frame({ data: "x", retry: 3_000 })).toBe("retry: 3000\ndata: x\n\n");
  });
});
