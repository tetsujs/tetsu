/**
 * Tests for the server-sent events helper.
 *
 * The framing is checked directly; the rest goes through a live server,
 * because "the client left" is not a thing a unit test can stage.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import { createApp, hook, route } from "@tetsujs/core";
import { captureErrors, serve } from "@tetsujs/core/testing";
import type { SseSummary } from "./index.ts";
import { frame, lastEventId, sse } from "./index.ts";

const cleaned: string[] = [];

const handed: AbortSignal[] = [];

const built = { events: 0 };

/** Settles when the stream is over — what a real source would wait on. */
function until(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

class FeedController {
  ticks = route({
    method: "GET",
    path: "/ticks",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: "first" };
          yield { data: { value: 2 }, id: "2", event: "update" };
        },
        { heartbeatMs: 0 },
      ),
  });

  endless = route({
    method: "GET",
    path: "/endless",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          try {
            for (let index = 0; ; index += 1) {
              yield { data: `tick ${index}` };

              await Bun.sleep(15);
            }
          } finally {
            cleaned.push("subscription closed");
          }
        },
        { heartbeatMs: 0 },
      ),
  });

  resumed = route({
    method: "GET",
    path: "/resumed",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: lastEventId(ctx) ?? "from the start" };
        },
        { heartbeatMs: 0 },
      ),
  });

  breaksLate = route({
    method: "GET",
    path: "/breaks-late",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: "first" };

          throw new Error("source exploded");
        },
        { heartbeatMs: 0 },
      ),
  });

  breaksEarly = route({
    method: "GET",
    path: "/breaks-early",
    handler: (ctx) =>
      sse(
        ctx,
        // biome-ignore lint/correctness/useYield: it fails before it yields.
        async function* () {
          throw new Error("subscription never opened");
        },
        { heartbeatMs: 0 },
      ),
  });

  unrepresentable = route({
    method: "GET",
    path: "/unrepresentable",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: "first" };
          yield { data: "second", id: "1\nevent: admin" };
        },
        { heartbeatMs: 0 },
      ),
  });

  quiet = route({
    method: "GET",
    path: "/quiet",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: "a" };

          await Bun.sleep(60);

          yield { data: "b" };
        },
        { heartbeatMs: 0 },
      ),
  });

  byDefault = route({
    method: "GET",
    path: "/by-default",
    handler: (ctx) =>
      sse(ctx, async function* () {
        yield { data: "a" };

        await Bun.sleep(60);

        yield { data: "b" };
      }),
  });

  waiting = route({
    method: "GET",
    path: "/waiting",
    handler: (ctx) =>
      sse(
        ctx,
        async function* (signal) {
          handed.push(signal);

          try {
            yield { data: "first" };

            await until(signal);
          } finally {
            cleaned.push("quiet source closed");
          }
        },
        { heartbeatMs: 0 },
      ),
  });

  firehose = route({
    method: "GET",
    path: "/firehose",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          while (true) {
            built.events += 1;

            yield { data: "x".repeat(100) };
          }
        },
        { heartbeatMs: 0 },
      ),
  });

  brief = route({
    method: "GET",
    path: "/brief",
    handler: (ctx) =>
      sse(
        ctx,
        async function* (signal) {
          handed.push(signal);

          yield { data: "only" };
        },
        { heartbeatMs: 0 },
      ),
  });

  deaf = route({
    method: "GET",
    path: "/deaf",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          try {
            yield { data: "first" };

            await new Promise(() => {});
          } finally {
            cleaned.push("deaf source closed");
          }
        },
        { heartbeatMs: 0 },
      ),
  });

  beating = route({
    method: "GET",
    path: "/beating",
    handler: (ctx) =>
      sse(
        ctx,
        async function* () {
          yield { data: "hello" };

          await Bun.sleep(200);
        },
        { heartbeatMs: 20 },
      ),
  });
}

const request = serve(createApp({ routes: new FeedController() }));

/** A source that only ever waits — nothing but the signal can end it. */
class ParkedController {
  parked = route({
    method: "GET",
    path: "/parked",
    handler: (ctx) =>
      sse(
        ctx,
        // biome-ignore lint/correctness/useYield: it waits instead.
        async function* (signal) {
          cleaned.push("parked source started");

          try {
            await until(signal);
          } finally {
            cleaned.push("parked source closed");
          }
        },
        { heartbeatMs: 0 },
      ),
  });
}

/**
 * Replaced by a hook that waits first — long enough for the stream to have
 * started its source by the time its response is thrown away.
 */
const replacedLater = serve(
  createApp({
    routes: new ParkedController(),
    hooks: {
      beforeResponse: [
        hook.beforeResponse(async () => {
          await Bun.sleep(5);

          return new Response("replaced");
        }),
      ],
    },
  }),
);

/**
 * Replaced in the same turn the handler returned in. The pipeline is
 * synchronous until something waits, so the stream may not have started
 * its source yet — and a source that never started holds nothing.
 */
const replacedAtOnce = serve(
  createApp({
    routes: new ParkedController(),
    hooks: {
      beforeResponse: [hook.beforeResponse(() => new Response("replaced"))],
    },
  }),
);

describe("a response the pipeline throws away", () => {
  test("ends the stream behind it, so a source that started unwinds", async () => {
    cleaned.length = 0;

    const res = await replacedLater("/parked");

    expect(await res.text()).toBe("replaced");

    await Bun.sleep(20);

    expect(cleaned).toEqual(["parked source started", "parked source closed"]);
  });

  test("leaves no source running, started or not", async () => {
    cleaned.length = 0;

    const res = await replacedAtOnce("/parked");

    expect(await res.text()).toBe("replaced");

    await Bun.sleep(20);

    expect(cleaned.includes("parked source closed")).toBe(
      cleaned.includes("parked source started"),
    );
  });
});

describe("the wire format", () => {
  test("a string payload is sent as it is", () => {
    expect(frame({ data: "hello" })).toBe("data: hello\n\n");
  });

  test("anything else is JSON", () => {
    expect(frame({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });

  test("every line of a multi-line payload is prefixed", () => {
    expect(frame({ data: "one\ntwo" })).toBe("data: one\ndata: two\n\n");
  });

  test("the optional fields come before the payload", () => {
    expect(frame({ data: "x", event: "update", id: 7, retry: 3_000 })).toBe(
      "event: update\nid: 7\nretry: 3000\ndata: x\n\n",
    );
  });

  test("a payload is split on every terminator the protocol has", () => {
    expect(frame({ data: "one\rtwo" })).toBe("data: one\ndata: two\n\n");
    expect(frame({ data: "one\r\ntwo" })).toBe("data: one\ndata: two\n\n");
    expect(frame({ data: "one\rtwo\nthree\r\nfour" })).toBe(
      "data: one\ndata: two\ndata: three\ndata: four\n\n",
    );
  });

  test("a line break in a single-line field is refused, not emitted", () => {
    expect(() => frame({ data: "x", event: "msg\nid: 999" })).toThrow(
      "an SSE event cannot contain a line break or NUL",
    );
    expect(() => frame({ data: "x", id: "1\nevent: admin" })).toThrow(
      "an SSE id cannot contain a line break or NUL",
    );
    expect(() => frame({ data: "x", id: "1\revent: admin" })).toThrow(
      "an SSE id cannot contain a line break or NUL",
    );
    expect(() => frame({ data: "x", event: "a\r\nb" })).toThrow(TypeError);
  });

  test("data with no JSON form is refused by name, not by a crash", () => {
    for (const data of [undefined, () => 1, Symbol("s")]) {
      expect(() => frame({ data })).toThrow(
        "an SSE event's data has no JSON form",
      );
    }
  });

  test("a NUL in an id is refused, because a client would drop it", () => {
    expect(() => frame({ data: "x", id: "1\u0000" })).toThrow(
      "an SSE id cannot contain a line break or NUL",
    );
  });

  test("what the field held is in the message, for the log to carry", () => {
    expect(() => frame({ data: "x", event: "msg\nid: 999" })).toThrow(
      '"msg\\nid: 999"',
    );
  });

  test("a numeric id still passes through", () => {
    expect(frame({ data: "x", id: 7 })).toBe("id: 7\ndata: x\n\n");
  });
});

describe("the response", () => {
  test("declares the stream and forbids caching", async () => {
    const res = await request("/ticks");

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    await res.text();
  });

  test("carries the events the generator yielded", async () => {
    const res = await request("/ticks");

    expect(await res.text()).toBe(
      'data: first\n\nevent: update\nid: 2\ndata: {"value":2}\n\n',
    );
  });

  test("reads the id a reconnecting client sends", async () => {
    const res = await request("/resumed", {
      headers: { "last-event-id": "42" },
    });

    expect(await res.text()).toBe("data: 42\n\n");
  });

  test("without that header the stream starts over", async () => {
    const res = await request("/resumed");

    expect(await res.text()).toBe("data: from the start\n\n");
  });
});

describe("the heartbeat", () => {
  test("keeps an idle connection busy", async () => {
    const res = await request("/beating");
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();

    let seen = "";

    while (!seen.includes(": ping")) {
      const chunk = await reader?.read();

      if (chunk?.done) {
        break;
      }

      seen += decoder.decode(chunk?.value);
    }

    expect(seen).toContain("data: hello");
    expect(seen).toContain(": ping");

    await reader?.cancel();
  });
});

describe("the client leaving", () => {
  const errors = captureErrors();

  test("ends the generator, running its cleanup", async () => {
    cleaned.length = 0;

    const controller = new AbortController();

    const res = await fetch(new URL("/endless", request.url).href, {
      signal: controller.signal,
    });

    const reader = res.body?.getReader();

    await reader?.read();

    controller.abort();

    await Bun.sleep(120);

    expect(cleaned).toEqual(["subscription closed"]);
  });

  test("is an ordinary end, not a failure worth reporting", async () => {
    // Without the abort check in the loop the departure still ends the
    // stream — one value later, when `enqueue` throws on a closed
    // controller — and an ordinary disconnect is logged as a generator
    // failure. The assertion is on the silence, which is the difference.
    const controller = new AbortController();

    const res = await fetch(new URL("/endless", request.url).href, {
      signal: controller.signal,
    });

    await res.body?.getReader().read();

    controller.abort();

    await Bun.sleep(120);

    expect(errors.lines).toEqual([]);
  });
});

describe("a client that does not read", () => {
  test("stops the generator instead of building events into memory", async () => {
    built.events = 0;

    const controller = new AbortController();

    await fetch(new URL("/firehose", request.url).href, {
      signal: controller.signal,
    });

    await Bun.sleep(300);

    const filled = built.events;

    await Bun.sleep(500);

    // Production plateaus at whatever the transport buffers hold and then
    // stops entirely: `pull` is not called again while the queue is full.
    // Driven from a loop in `start` this was millions of events and still
    // climbing, because `enqueue` never refuses.
    expect(built.events).toBe(filled);
    expect(filled).toBeLessThan(50_000);
    expect(filled).toBeGreaterThan(0);

    controller.abort();

    await Bun.sleep(50);
  });
});

describe("a source that goes quiet", () => {
  /** Reads one event, then leaves. */
  async function leaveAfterFirstEvent(path: string): Promise<void> {
    cleaned.length = 0;

    const controller = new AbortController();

    const res = await fetch(new URL(path, request.url).href, {
      signal: controller.signal,
    });

    await res.body?.getReader().read();

    controller.abort();

    await Bun.sleep(120);
  }

  test("is unwound when it waits on the signal", async () => {
    await leaveAfterFirstEvent("/waiting");

    expect(cleaned).toEqual(["quiet source closed"]);
  });

  test("is not unwound when it ignores the signal, and cannot be", async () => {
    await leaveAfterFirstEvent("/deaf");

    expect(cleaned).toEqual([]);
  });

  test("is told the stream is over when it ends on its own too", async () => {
    // A source that ties a resource to the signal — a broker subscription,
    // a watch — releases it when that signal fires, and a generator that
    // simply runs out is the one case where nothing outside is aborting.
    handed.length = 0;

    const res = await fetch(new URL("/brief", request.url).href);

    expect(await res.text()).toBe("data: only\n\n");

    expect(handed[0]?.aborted).toBe(true);
  });
});

describe("a generator that fails", () => {
  const errors = captureErrors();

  test("after an event: what went out stays, the stream ends cleanly", async () => {
    const res = await fetch(new URL("/breaks-late", request.url).href);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: first\n\n");
    expect(errors.lines.join("\n")).toContain("[tetsu] stream failed:");
    expect(errors.lines.join("\n")).toContain("source exploded");
  });

  test("before any event: an empty stream is not silent", async () => {
    const res = await fetch(new URL("/breaks-early", request.url).href);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(errors.lines.join("\n")).toContain("[tetsu] stream failed:");
    expect(errors.lines.join("\n")).toContain("subscription never opened");
  });

  test("on a field the wire cannot carry, the refusal is reported", async () => {
    const res = await fetch(new URL("/unrepresentable", request.url).href);
    const body = await res.text();

    expect(body).toBe("data: first\n\n");
    expect(body).not.toContain("event: admin");
    expect(errors.lines.join("\n")).toContain("[tetsu] stream failed:");
    expect(errors.lines.join("\n")).toContain("an SSE id cannot contain");
  });
});

describe("the heartbeat's own contract", () => {
  test("zero turns it off, as the option says", async () => {
    const res = await request("/quiet");

    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
  });

  test("and the default is slow enough not to show up here", async () => {
    // The documented default is 15 seconds; a stream idle for 60 ms must
    // carry no ping. Nothing pinned the number itself, so a default of a
    // millisecond used to pass the suite unnoticed.
    const res = await request("/by-default");

    expect(await res.text()).toBe("data: a\n\ndata: b\n\n");
  });
});

describe("what a finished stream reports", () => {
  const errors = captureErrors();

  const summaries: SseSummary[] = [];

  const watch = (summary: SseSummary): void => {
    summaries.push(summary);
  };

  class ReportingController {
    short = route({
      method: "GET",
      path: "/short",
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            yield { data: "one" };
            yield { data: "two" };
          },
          { heartbeatMs: 0, onEnd: watch },
        ),
    });

    endless = route({
      method: "GET",
      path: "/endless",
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            for (let index = 0; ; index += 1) {
              yield { data: `tick ${index}` };

              await Bun.sleep(15);
            }
          },
          { heartbeatMs: 0, onEnd: watch },
        ),
    });

    breaks = route({
      method: "GET",
      path: "/breaks",
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            yield { data: "one" };

            throw new Error("source is gone");
          },
          { heartbeatMs: 0, onEnd: watch },
        ),
    });

    beating = route({
      method: "GET",
      path: "/beating",
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            yield { data: "one" };

            await Bun.sleep(60);
          },
          { heartbeatMs: 15, onEnd: watch },
        ),
    });

    noisy = route({
      method: "GET",
      path: "/noisy",
      handler: (ctx) =>
        sse(
          ctx,
          async function* () {
            yield { data: "one" };
          },
          {
            heartbeatMs: 0,
            onEnd: () => {
              throw new Error("the observer is broken");
            },
          },
        ),
    });
  }

  const reporting = serve(createApp({ routes: new ReportingController() }));

  test("a generator that ran out says so, with what it sent", async () => {
    summaries.length = 0;

    await (await reporting("/short")).text();
    await Bun.sleep(20);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ reason: "ended", events: 2 });
    expect(summaries[0]?.bytes).toBe("data: one\n\ndata: two\n\n".length);
    expect(summaries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a client that left says cancelled, once", async () => {
    summaries.length = 0;

    const controller = new AbortController();

    const res = await fetch(new URL("/endless", reporting.url).href, {
      signal: controller.signal,
    });

    await res.body?.getReader().read();

    controller.abort();

    await Bun.sleep(120);

    // Four paths can end a stream; the summary is reported by whichever
    // got there first, and only then.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.reason).toBe("cancelled");
    expect(summaries[0]?.events).toBeGreaterThan(0);
  });

  test("a generator that threw says failed, and counts what got out", async () => {
    summaries.length = 0;

    await (await reporting("/breaks")).text();
    await Bun.sleep(20);

    expect(summaries[0]).toMatchObject({ reason: "failed", events: 1 });
  });

  test("heartbeats are bytes on the wire but not events", async () => {
    summaries.length = 0;

    const res = await reporting("/beating");
    const body = await res.text();

    await Bun.sleep(20);

    expect(body).toContain(": ping");
    expect(summaries[0]?.events).toBe(1);
    expect(summaries[0]?.bytes).toBe(body.length);
  });

  test("a response the pipeline threw away is reported too", async () => {
    summaries.length = 0;

    const replaced = serve(
      createApp({
        hooks: {
          beforeResponse: [hook.beforeResponse(() => new Response("no"))],
        },
        routes: {
          feed: route({
            method: "GET",
            path: "/feed",
            handler: (ctx) =>
              sse(
                ctx,
                async function* () {
                  yield { data: "one" };

                  await Bun.sleep(200);
                },
                { heartbeatMs: 0, onEnd: watch },
              ),
          }),
        },
      }),
    );

    expect(await (await replaced("/feed")).text()).toBe("no");

    await Bun.sleep(40);

    // The client saw a different response entirely, so nothing about this
    // stream would reach a log without the summary — and a stream nobody
    // read is exactly the one worth hearing about.
    expect(summaries[0]?.reason).toBe("cancelled");
  });

  test("an observer that throws does not break the teardown", async () => {
    const res = await reporting("/noisy");

    expect(await res.text()).toBe("data: one\n\n");
    expect(errors.lines.join("\n")).toContain("[tetsu] stream failed:");
  });
});
