---
title: Streaming
description: Responses that arrive over time — a Response carrying a stream, backpressure with a pull source, sse() and stream() from @tetsujs/sse, and why a generator must yield or wait on its signal.
sidebar:
  order: 12
---

A streamed response sends its body as it is produced: server-sent events, a
large export, a model's tokens. This page covers how a handler returns
one, what backpressure asks of the source, what `@tetsujs/sse` does for
you, and the one rule a generator behind a stream has to keep.

## A `Response` carrying a stream

A handler that streams returns a `Response` whose body is the stream. The
framework does not wrap a bare stream for you: a `ReadableStream` or a
generator returned on its own is a compile error, and a `500` at runtime,
because as JSON it would serialize to `{}` and the body would be lost
without a word. The `Response` is also where the content type is stated,
which a bare stream does not carry.

Because it is a `Response`, it is sent as it is: no response schema checks
it, and `ctx.out.headers` is laid over it like over any other response.

The status and headers leave with the first chunk of the body, not before.
A stream that has nothing to say for a while keeps its client waiting for
the headers too, so it should write something the format allows as soon
as it can.

## Backpressure

A client reads at its own pace, and a source that produces faster than
that fills memory with chunks nobody has read yet. `enqueue` never blocks
and never refuses, so a stream fed from a loop in `start()` builds every
chunk at once, whether the client is reading or gone.

A `pull()` source is what applies backpressure: the platform calls it
while the stream wants more and stops calling it when the client does not
keep up, so the source advances at the rate the client reads.

```ts twoslash
import { route } from "@tetsujs/core";
interface Order { id: number; total: number }
declare const orders: { cursor(): AsyncGenerator<Order, void, undefined> };
// ---cut---
route({
  method: "GET",
  path: "/orders.ndjson",
  handler: () => {
    const rows = orders.cursor();
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = await rows.next();

          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        },
        async cancel() {
          await rows.return();
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  },
});
```

Two details in it matter.

**`highWaterMark: 0`.** With the default of `1`, the platform calls
`pull()` once as soon as the stream is constructed, before anyone reads it,
to fill its queue. A stream can be built and never sent — a
`beforeResponse` hook replaces the response, an error displaces it, a
`HEAD` request is answered without a body — and the first `pull()` then
starts a query, a timer or a subscription for nobody. With `0`, nothing
runs until a consumer asks.

**`cancel()`.** A response the pipeline builds and then does not send is
released: its body is cancelled, which runs the source's `cancel()`. So
does a client that leaves mid-stream. That is where a cursor is closed or a
subscription dropped, whichever way the stream ended.

## `sse()` and `stream()`

[`@tetsujs/sse`](/docs/packages/sse/) builds such a `Response` from an
async generator and handles what a stream written by hand gets wrong:
backpressure, stopping when the client leaves, ending the generator, and
reporting a failure.

`sse()` frames every yielded event for `EventSource`, sends keep-alive
comments so proxies do not close an idle connection, and opens with a
comment so the headers leave at once:

```ts twoslash
import { route } from "@tetsujs/core";
import { sse } from "@tetsujs/sse";
// ---cut---
route({
  method: "GET",
  path: "/clock",
  handler: (ctx) =>
    sse(ctx, async function* (signal) {
      while (!signal.aborted) {
        yield { event: "tick", data: { at: new Date().toISOString() } };
        await Bun.sleep(1_000);
      }
    }),
});
```

`stream()` is the same machinery without the framing, for NDJSON, CSV or
anything else, with the content type stated:

```ts twoslash
import { route } from "@tetsujs/core";
import { stream } from "@tetsujs/sse";
interface Order { id: number; total: number }
declare const orders: { cursor(): AsyncGenerator<Order, void, undefined> };
// ---cut---
route({
  method: "GET",
  path: "/orders.ndjson",
  handler: (ctx) =>
    stream(
      ctx,
      async function* () {
        for await (const order of orders.cursor()) yield `${JSON.stringify(order)}\n`;
      },
      { contentType: "application/x-ndjson" },
    ),
});
```

The package page covers events, resuming with `Last-Event-ID`,
keep-alives, `onEnd` summaries and every option.

## A generator must yield or wait on the signal

The generator behind `sse()` or `stream()` receives an `AbortSignal` that
fires when the stream is over: the client left, the response was
discarded, or the stream was ended from outside.

A generator between two `yield`s leaves on its own. The stream sees the
abort at the next value and calls the generator's `return()`, which runs
its `finally`. A generator parked inside an `await` is woken by nothing:
`return()` is queued behind that `await` and applies only once it settles.
An `await` on a source that has gone quiet — a queue with no traffic, a
poll of something unchanged — never settles, and the subscription inside
it lives as long as the process. Cancelling the stream does not change
that, and neither does calling `return()`.

So the rule is: **a stream ends with the connection if its generator keeps
yielding, or if it waits on the signal.** A generator that can go quiet
passes the signal to whatever it waits for:

```ts twoslash
import { route } from "@tetsujs/core";
import { sse } from "@tetsujs/sse";
interface Price { at: string; value: number }
interface Subscription extends AsyncIterable<Price> { close(): Promise<void> }
declare const broker: { subscribe(topic: string, options: { signal: AbortSignal }): Promise<Subscription> };
// ---cut---
route({
  method: "GET",
  path: "/prices",
  handler: (ctx) =>
    sse(ctx, async function* (signal) {
      const queue = await broker.subscribe("prices", { signal });

      try {
        for await (const price of queue) yield { data: price, id: price.at };
      } finally {
        await queue.close();
      }
    }),
});
```

A source that takes the signal rejects with an `AbortError` when the
client leaves — `fetch`, `events.on` and the timers of
`node:timers/promises` do. That is the client leaving, not the source
failing, and nothing is reported.

## Failures and the end of a stream

A generator that throws ends the stream where it stood. The status and
headers have already gone, so there is no `onError` to hand the error to:
it goes to `reportError` with `source: "stream"`. What already went out
stays valid, and the client sees an ordinary end of stream.

An access log written in `afterResponse` sees a stream when it starts,
so it records an hour-long feed as a fast `200`. `onEnd` on `sse()` and
`stream()` reports how the stream actually ended, with its size and
duration.

## Ending streams on shutdown

A server that is stopping waits for every response in flight, and a stream
is one that never finishes on its own. `until` on `sse()` and `stream()`
ends it from outside when a signal fires. With
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/#streams-and-long-polls),
that signal is `draining`, and the client reconnects to a server that
stays:

```ts twoslash
import { createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { sse } from "@tetsujs/sse";
declare const feed: (signal: AbortSignal) => AsyncGenerator<{ data: unknown }, void, undefined>;
// ---cut---
const live = route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: shutdown.draining }),
});

const server = Bun.serve({ ...createApp({ routes: [live] }) });
const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

A stream written by hand ends on the same signal by combining it with the
request's own — see [Cancellation and timeouts](/docs/concepts/cancellation/).
