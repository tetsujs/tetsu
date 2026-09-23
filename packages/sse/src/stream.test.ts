/**
 * Tests for the generic stream, through a live server.
 *
 * What `sse()` is built on, exercised without its wire format: the
 * backpressure, the signal handed to the source, and the summary. The
 * SSE tests cover the same machinery through the helper; these cover it
 * as the thing a caller reaches for when the format is their own.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { serve, testCtx } from "@tetsujs/core/testing";
import type { StreamSummary } from "./stream.ts";
import { stream } from "./stream.ts";

const summaries: StreamSummary[] = [];

const watch = (summary: StreamSummary): void => {
  summaries.push(summary);
};

let produced = 0;
let unwound = false;

class Controller {
  rows = route({
    method: "GET",
    path: "/rows",
    handler: (ctx) =>
      stream(
        ctx,
        async function* () {
          for (const id of [1, 2, 3]) {
            yield `${JSON.stringify({ id })}\n`;
          }
        },
        { contentType: "application/x-ndjson", onEnd: watch },
      ),
  });

  plain = route({
    method: "GET",
    path: "/plain",
    handler: (ctx) =>
      stream(ctx, async function* () {
        yield "no type declared";
      }),
  });

  firehose = route({
    method: "GET",
    path: "/firehose",
    handler: (ctx) =>
      stream(ctx, async function* () {
        while (produced < 1_000_000) {
          produced += 1;

          yield "x".repeat(100);
        }
      }),
  });

  waiting = route({
    method: "GET",
    path: "/waiting",
    handler: (ctx) =>
      stream(
        ctx,
        async function* (signal) {
          try {
            yield "first\n";

            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          } finally {
            unwound = true;
          }
        },
        { onEnd: watch },
      ),
  });
}

const request = serve(createApp({ routes: new Controller() }));

describe("a source that runs out", () => {
  test("ends the body right after its last chunk, and says so once", async () => {
    const ended: StreamSummary[] = [];

    const res = stream(
      testCtx({}),
      async function* () {
        yield "only\n";
      },
      { onEnd: (summary) => ended.push(summary) },
    );

    // Read in process, one chunk at a time, and first in the file: over a
    // live server, a body that never ends is drained in a loop of
    // microtasks that no test timeout interrupts, so the tests after this
    // one hang the run — by then this failure has been printed.
    const reader = res.body?.getReader();
    const first = await reader?.read();

    expect(new TextDecoder().decode(first?.value)).toBe("only\n");
    expect(await reader?.read()).toEqual({ done: true, value: undefined });
    expect(ended.map((summary) => summary.reason)).toEqual(["ended"]);
  });
});

describe("a stream of somebody else's format", () => {
  test("carries the content type it was given, and nothing it was not", async () => {
    const typed = await request("/rows");
    const bare = await request("/plain");

    expect(typed.headers.get("content-type")).toBe("application/x-ndjson");
    expect(bare.headers.get("content-type")).toBeNull();
  });

  test("writes what the generator yielded, in order", async () => {
    const res = await request("/rows");

    expect(await res.text()).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  });

  test("reports what it did", async () => {
    summaries.length = 0;

    await (await request("/rows")).text();
    await Bun.sleep(20);

    expect(summaries[0]).toMatchObject({ chunks: 3, reason: "ended" });
    expect(summaries[0]?.bytes).toBe('{"id":1}\n{"id":2}\n{"id":3}\n'.length);
  });
});

describe("the machinery under it", () => {
  test("stops producing for a client that stops reading", async () => {
    produced = 0;

    const controller = new AbortController();

    await fetch(new URL("/firehose", request.url).href, {
      signal: controller.signal,
    });

    await Bun.sleep(300);

    const filled = produced;

    await Bun.sleep(400);

    expect(produced).toBe(filled);
    expect(filled).toBeLessThan(50_000);

    controller.abort();

    await Bun.sleep(50);
  });

  test("hands the source a signal that frees a quiet one", async () => {
    summaries.length = 0;
    unwound = false;

    const controller = new AbortController();

    const res = await fetch(new URL("/waiting", request.url).href, {
      signal: controller.signal,
    });

    await res.body?.getReader().read();

    controller.abort();

    await Bun.sleep(150);

    // A source parked inside an `await` is woken by nothing else: not by
    // cancelling the stream, not by `return()` on the generator. Only the
    // signal reaches it, and the `finally` is the proof it arrived.
    expect(unwound).toBe(true);
    expect(summaries[0]?.reason).toBe("cancelled");
  });
});
