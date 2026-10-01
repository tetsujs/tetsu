/**
 * Tests for how a stream starts and how it takes a client leaving.
 *
 * A client that leaves is the ordinary end of a feed, and the docs ask
 * the source to take the signal and its `finally` to clean up. Both used
 * to turn that ordinary end into a failure: a source rejecting with the
 * signal's `AbortError` was reported as a broken stream, and a `finally`
 * that threw went unhandled and took the process down. A feed with no
 * event yet sent nothing at all, headers included, until its first event
 * or heartbeat — and a browser waited in "connecting" meanwhile.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { FailureReport } from "@tetsujs/core";
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import type { SseSummary } from "./index.ts";
import { sse } from "./index.ts";

const reports: FailureReport<object>[] = [];
const summaries: SseSummary[] = [];
const request = serve(
  createApp({
    reportError: (report) => reports.push(report),
    routes: {
      rejecting: route({
        method: "GET",
        path: "/rejecting",
        handler: (ctx) =>
          sse(
            ctx,
            async function* (signal) {
              yield { data: "first" };

              await new Promise((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            },
            { heartbeatMs: 0, onEnd: (summary) => summaries.push(summary) },
          ),
      }),
      closing: route({
        method: "GET",
        path: "/closing",
        handler: (ctx) =>
          sse(
            ctx,
            async function* () {
              try {
                for (let index = 0; ; index += 1) {
                  yield { data: `tick ${index}` };

                  await Bun.sleep(10);
                }
              } finally {
                // The broker is gone, and closing the subscription fails.
                // biome-ignore lint/correctness/noUnsafeFinally: the point.
                throw new Error("broker unreachable");
              }
            },
            { heartbeatMs: 0 },
          ),
      }),
      parked: route({
        method: "GET",
        path: "/parked",
        handler: (ctx) =>
          sse(
            ctx,
            async function* (signal) {
              yield { data: "first" };

              try {
                await new Promise<void>((resolve) => {
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
              } finally {
                // biome-ignore lint/correctness/noUnsafeFinally: the point.
                throw new Error("broker unreachable");
              }
            },
            { heartbeatMs: 0, onEnd: (summary) => summaries.push(summary) },
          ),
      }),
      quiet: route({
        method: "GET",
        path: "/quiet",
        handler: (ctx) =>
          sse(
            ctx,
            async function* (signal) {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            },
            { heartbeatMs: 0, onEnd: (summary) => summaries.push(summary) },
          ),
      }),
    },
  }),
);

/** Opens a stream, reads its first chunk, and leaves. */
async function leave(path: string): Promise<void> {
  const controller = new AbortController();
  const res = await fetch(new URL(path, request.url).href, {
    signal: controller.signal,
  });

  await res.body?.getReader().read();

  controller.abort();

  await Bun.sleep(100);
}

describe("a client leaving a source that rejects with the signal", () => {
  test("is an ordinary end, not a failure", async () => {
    reports.length = 0;
    summaries.length = 0;

    await leave("/rejecting");

    expect(reports).toEqual([]);
    expect(summaries.map((summary) => summary.reason)).toEqual(["cancelled"]);
  });
});

describe("a cleanup that throws when the client leaves", () => {
  // Bun's test runner fails a test on a rejection nobody handled, which is
  // what this one did: the assertion on the report is the rest of it.
  test("is reported, and nothing goes unhandled", async () => {
    reports.length = 0;

    await leave("/closing");

    expect(
      reports.map((report) => [report.source, (report.error as Error).message]),
    ).toEqual([["stream", "broker unreachable"]]);
  });
});

describe("a cleanup that throws in a source waiting on the signal", () => {
  test("is reported too, on a stream the client ended", async () => {
    reports.length = 0;
    summaries.length = 0;

    await leave("/parked");

    expect(
      reports.map((report) => [report.source, (report.error as Error).message]),
    ).toEqual([["stream", "broker unreachable"]]);
    expect(summaries.map((summary) => summary.reason)).toEqual(["cancelled"]);
  });
});

describe("a feed with nothing to say yet", () => {
  test("answers at once, so the client knows it is connected", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const res = await fetch(new URL("/quiet", request.url).href, {
      signal: controller.signal,
    });
    const waited = performance.now() - started;

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(waited).toBeLessThan(1_000);

    const first = await res.body?.getReader().read();

    expect(new TextDecoder().decode(first?.value)).toBe(": open\n\n");

    controller.abort();

    await Bun.sleep(50);
  });

  test("and the opening is not counted as an event", async () => {
    summaries.length = 0;

    await leave("/quiet");

    expect(summaries[0]?.events).toBe(0);
    expect(summaries[0]?.bytes).toBe(": open\n\n".length);
  });
});
