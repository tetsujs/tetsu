---
title: "@tetsujs/sse"
description: Server-sent events from an async generator, and the same machinery for any other streamed format.
sidebar:
  order: 9
  label: "@tetsujs/sse"
---

`@tetsujs/sse` turns an async generator into a server-sent events response, with
the framing, the headers, the keep-alive and the backpressure that go
quietly wrong when written by hand. The same machinery, `stream()`, serves any other streamed
format. For how streaming fits into a handler, see
[Streaming](/docs/concepts/streaming/).

```bash
bun add @tetsujs/sse
```

## Usage

```ts twoslash
import { route } from "@tetsujs/core";

interface Price { at: number; value: number }
declare const prices: { watch(options: { signal: AbortSignal }): AsyncIterable<Price> };
// ---cut---
import { sse } from "@tetsujs/sse";

const feed = route({
  method: "GET",
  path: "/prices",
  handler: (ctx) =>
    sse(ctx, async function* (signal) {
      for await (const price of prices.watch({ signal })) {
        yield { data: price, id: price.at };
      }
    }),
});
```

`sse()` sets the SSE headers (`content-type: text/event-stream` and
`cache-control: no-cache`), frames every event, sends a keep-alive comment
every 15 seconds so proxies do not close an idle connection, and pulls events
one at a time. A client that stops reading stops the generator instead of
filling memory.

It opens with a comment, `: open`, which every client skips. Bun sends the
status and headers with the first bytes of the body, so without it a feed with
nothing to say yet answered nothing at all: a browser's `EventSource` waited in
"connecting" until the first event or keep-alive.

An event:

```ts
yield {
  data: { price: 42 }, // a string is sent as is, anything else as JSON
  event: "tick",       // the name for addEventListener
  id: "1712",          // sent back as Last-Event-ID when the browser reconnects
  retry: 3_000,        // how long the browser waits before reconnecting
};
```

| Field | |
| --- | --- |
| `data` | the payload: a string is sent as it is, anything else as JSON. A value with no JSON form, such as `undefined`, throws instead of being sent as an empty event |
| `event` | the name, read by `addEventListener(name)` instead of `onmessage` |
| `id` | a string or a number; the browser sends the last one back as `Last-Event-ID` |
| `retry` | milliseconds the browser waits before reconnecting; a whole number, 0 or more |

A multi-line payload is framed correctly: every line carries its own `data:`
prefix, whichever of CR, LF or CRLF ends it. `event` and `id` cannot span lines,
so a value holding a line break or a NUL throws a `TypeError`. Stripping it
quietly would resume a stream somewhere else, and passing it on would let a
value built from outside input, such as a topic name, add a field of its own to
the event.

## Resuming

A browser that lost the connection reconnects with the last id it saw.
`lastEventId(ctx)` reads it, so the stream can continue from there:

```ts twoslash
import { route } from "@tetsujs/core";

interface Item { id: string; text: string }
declare const history: { since(id: string | undefined): AsyncIterable<Item> };
// ---cut---
import { lastEventId, sse } from "@tetsujs/sse";

const resume = route({
  method: "GET",
  path: "/history",
  handler: (ctx) =>
    sse(ctx, async function* () {
      for await (const item of history.since(lastEventId(ctx))) {
        yield { data: item, id: item.id };
      }
    }),
});
```

## Cleaning up

The generator receives an `AbortSignal` that fires when the stream is over: the
client left, the response was discarded, or the generator finished.

A generator that yields regularly needs nothing more. When the client leaves,
its loop ends and its `finally` runs. **A generator that can go quiet must pass
the signal on** to whatever it waits for, such as a queue with no traffic or a
poll of something unchanged. Otherwise it waits forever and is never cleaned up:
a generator parked inside an `await` is resumed by nothing, and neither closing
the stream nor `return()` on the generator wakes it.

```ts twoslash
import { route } from "@tetsujs/core";

interface Price { at: number; value: number }
interface Queue extends AsyncIterable<Price> { close(): Promise<void> }
declare const broker: { subscribe(topic: string, options: { signal: AbortSignal }): Promise<Queue> };
// ---cut---
import { sse } from "@tetsujs/sse";

const prices = route({
  method: "GET",
  path: "/prices",
  handler: (ctx) =>
    sse(ctx, async function* (signal) {
      const queue = await broker.subscribe("prices", { signal });

      try {
        for await (const price of queue) {
          yield { data: price, id: price.at };
        }
      } finally {
        await queue.close();
      }
    }),
});
```

A generator that throws ends the stream where it stood, and the error goes to
the application's `reportError` with `source: "stream"`, printed as `[tetsu]
stream failed:` when there is none. The response has already left, so there is
no `onError` to hand it to. So does a `finally` that throws while the stream is
being closed, such as a broker that refuses to close a subscription. An
`onEnd` that throws is reported the same way.

A server that is stopping waits for every response in flight, and a stream is
one that never finishes: `until` ends it from outside. With
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/#streams-and-long-polls), that
is the `draining` signal. The stream closes as the server starts to stop, and
its client reconnects to another:

```ts twoslash
import { route } from "@tetsujs/core";
import { sse, type ServerSentEvent } from "@tetsujs/sse";

declare const draining: AbortSignal;
declare function feed(signal: AbortSignal): AsyncGenerator<ServerSentEvent, void, undefined>;
// ---cut---
const live = route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: draining }),
});
```

A source that takes the signal rejects when the client leaves: `fetch`,
`events.on` and the timers of `node:timers/promises` throw the signal's
`AbortError`. That is the client leaving, not the source failing. The stream
ends as `"cancelled"`, and nothing is reported.

## Knowing what a stream did

An access log sees a stream when it starts, so it records a long feed as a fast
`200`. `onEnd` reports how it actually ended:

```ts twoslash
import { route } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import { sse, type ServerSentEvent } from "@tetsujs/sse";

declare const logger: { info(fields: object, message: string): void };
declare function feed(signal: AbortSignal): AsyncGenerator<ServerSentEvent, void, undefined>;
// ---cut---
const live = route({
  method: "GET",
  path: "/feed",
  hooks: { beforeParse: [requestId()] },
  handler: (ctx) =>
    sse(ctx, feed, {
      onEnd: (summary) => logger.info({ ...summary, requestId: ctx.requestId }, "stream closed"),
      //      ^? (parameter) summary: SseSummary
    }),
});
// { events: 412, bytes: 38104, durationMs: 2401882.6, reason: "cancelled" }
```

`reason` is `"ended"` (the generator finished), `"cancelled"` (the client left,
the response was discarded, or `until` fired) or `"failed"` (the generator
threw). `events` counts the events written, not the keep-alives or the opening;
`bytes` counts everything put on the wire, those included. The summary carries
no request id on purpose: the callback is written where `ctx` is in scope, so
you add what identifies the request. It is reported for a stream that went
out; one that was made and never sent has nothing to report.

## Other formats: stream()

`sse()` is `stream()` with SSE framing on top. For anything else, such as
NDJSON, CSV or a model's tokens, `stream()` takes the chunks as they are, with
the same backpressure, signal and summary:

```ts twoslash
import { route } from "@tetsujs/core";

declare const rows: { watch(options: { signal: AbortSignal }): AsyncIterable<{ id: number }> };
// ---cut---
import { stream } from "@tetsujs/sse";

const exportRows = route({
  method: "GET",
  path: "/rows",
  handler: (ctx) =>
    stream(
      ctx,
      async function* (signal) {
        for await (const row of rows.watch({ signal })) {
          yield `${JSON.stringify(row)}\n`;
        }
      },
      { contentType: "application/x-ndjson" },
    ),
});
```

`stream()` sends no keep-alives unless asked, and no opening either, because not
every format has a line a client will ignore. Bun sends the status and headers
with the first chunk, so a stream that may take a while to produce one keeps its
client waiting for the headers too. Yield something the format allows as soon as
there is something to say, or ask for a keep-alive:

```ts twoslash
import { stream } from "@tetsujs/sse";
import type { BaseCtx } from "@tetsujs/core";

declare const ctx: BaseCtx;
declare function chunks(signal: AbortSignal): AsyncGenerator<string, void, undefined>;
// ---cut---
const response = stream(ctx, chunks, { keepAlive: { everyMs: 15_000, chunk: "\n" } });
```

The keep-alive `chunk` has to be something the consumer's parser ignores: a
comment in a format that has them, a blank line in one that does not.

## Options

| `sse()` | Default | |
| --- | --- | --- |
| `heartbeatMs` | `15000` | keep-alive interval; `0` turns it off |
| `status` | `200` | |
| `until` | none | a signal that ends the stream, such as `draining` when the server stops |
| `onEnd` | none | receives the summary when the stream ends |

| `stream()` | Default | |
| --- | --- | --- |
| `contentType` | none | the `content-type` header |
| `status` | `200` | |
| `headers` | none | more response headers |
| `keepAlive` | off | `{ everyMs, chunk }` |
| `until` | none | a signal that ends the stream |
| `onEnd` | none | receives the summary; it counts `chunks` instead of `events` |

The keep-alive of `sse()` is the comment `: ping`. The package exports the types
`ServerSentEvent`, `SseOptions`, `SseSummary`, `SseReason`, `StreamOptions`,
`StreamSummary`, `StreamReason` and `KeepAlive`, and `frame(event)`, which
formats one event as it goes over the wire.

## Notes

- **`sse()` and `stream()` need a `ctx`,** and read `ctx.req.signal` from it: a
  client that disconnects ends the stream.
- **Backpressure.** Events are produced on demand, one at a time, at the rate
  they are read, so a slow client costs a buffer rather than a heap.
- **A stream is a `Response`,** so it works anywhere a handler may return one.
  The framework needs none of this package to stream; what it adds is the wire
  format, the proxy-facing headers, the heartbeat, the signal and the
  backpressure.
