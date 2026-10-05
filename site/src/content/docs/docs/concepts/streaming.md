---
title: Streaming
description: Responses that arrive over time — a Response carrying a stream, sse() and stream() from @tetsujs/sse, backpressure with a pull source, and why a generator must yield or wait on its signal.
sidebar:
  order: 12
---

A streamed response sends its body as it is produced: server-sent events, a
large export, a model's tokens. Most streams are easiest to write with
`@tetsujs/sse`; a stream written by hand has a few rules to follow.

## A `Response` carrying a stream

A handler that streams returns a `Response` whose body is the stream. A
bare `ReadableStream` or generator is a compile error and a `500` at
runtime: as JSON it would be `{}`. The `Response` is also where the content
type is stated.

Like any `Response`, it is not checked by a response schema, and
`ctx.out.headers` is applied to it.

The status and headers leave with the first chunk of the body. A stream
that has nothing to send for a while keeps the client waiting for the
headers too, so write something the format allows as soon as you can.

## `sse()` and `stream()`

[`@tetsujs/sse`](/docs/packages/sse/) builds the `Response` from an async
generator, and handles what a hand-written stream tends to get wrong:
backpressure, stopping when the client leaves, ending the generator, and
reporting a failure.

`sse()` formats each yielded event for `EventSource`, sends keep-alive
comments so neither Bun nor a proxy closes an idle connection, and sends a
first comment so the headers leave at once:

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

`stream()` is the same without the event format, for NDJSON, CSV or
anything else:

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

The package page covers event ids and `Last-Event-ID`, keep-alives, `onEnd`
summaries and every option.

## A generator must yield or wait on the signal

The generator behind `sse()` or `stream()` receives an `AbortSignal` that
fires when the stream is over: the client left, the response was discarded,
`until` fired, or the generator ended.

A generator that keeps yielding stops on its own: at the next value the
stream sees the abort and calls `return()`, which runs its `finally`. A
generator stuck in an `await` is not woken by anything. If it waits on a
source that has gone quiet, such as a queue with no traffic, it never
resumes, and the subscription inside it lives as long as the process.

So **a stream ends with the connection only if its generator keeps
yielding, or waits on the signal.** A generator that can go quiet passes
the signal to whatever it waits on:

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

A source that takes the signal, such as `fetch`, `events.on` or the timers
of `node:timers/promises`, rejects with an `AbortError` when the client
leaves. That is not reported as a failure.

## Failures and the end of a stream

A generator that throws ends the stream where it stood. The headers have
already gone, so the error goes to `reportError` with `source: "stream"`,
and the client sees an ordinary end of stream.

An access log in `afterResponse` sees a stream when it starts, so it
records an hour-long feed as a fast `200`. `onEnd` on `sse()` and
`stream()` reports how the stream really ended, with its size and duration.

## Ending streams on shutdown

A stopping server waits for every response in flight, and a stream may
never finish on its own. `until` on `sse()` and `stream()` ends it when a
signal fires. With `@tetsujs/lifecycle` that signal is `draining`, and the
client reconnects to a server that stays; see
[Health checks and shutdown](/docs/guides/health-and-shutdown/#streams-and-sockets).

## A stream written by hand

A client reads at its own pace. `enqueue` never blocks, so a stream fed
from a loop in `start()` builds every chunk at once, whether the client is
reading or gone. A `pull()` source applies backpressure: the platform calls
it only while the stream wants more, so the source advances at the rate the
client reads.

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

- **`highWaterMark: 0`.** With the default of `1`, the platform calls
  `pull()` as soon as the stream is built. A response can be built and
  never sent (a hook replaced it, an error displaced it, a `HEAD` request
  has no body), and that first `pull()` would start work for nobody.
- **`cancel()`.** A response the pipeline builds and does not send has its
  body cancelled, and so does a client that leaves mid-stream. `cancel()`
  is where a cursor is closed or a subscription dropped.
- **An idle connection.** Bun closes a connection that sends nothing for
  its `idleTimeout`, 10 seconds unless set. A stream that can stay quiet
  longer writes something its format ignores on a timer, and raises its
  request's timeout above that with `ctx.server.timeout()`, as `sse()`
  does.

To end such a stream on shutdown too, give its source
`AbortSignal.any([ctx.req.signal, shutdown.draining])`, as
[Cancellation and timeouts](/docs/concepts/cancellation/) combines a
deadline with the request's signal.
