---
title: "@tetsujs/sse"
description: Server-sent events from an async generator, and the same machinery for any other streamed format.
sidebar:
  order: 9
  label: "@tetsujs/sse"
---

`@tetsujs/sse` turns an async generator into a server-sent events response. It
handles the framing, the headers, the keep-alive and the backpressure, which
are easy to get quietly wrong by hand. `stream()` does the same for any other
streamed format. For how streaming fits into a handler, see
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

`sse()` returns a `Response` that:

- sets `content-type: text/event-stream` and `cache-control: no-cache`;
- opens with a comment, `: open`, so the headers go out at once rather than
  with the first event;
- sends a `: ping` comment every 15 seconds, so proxies do not close an idle
  connection;
- asks the generator for one event at a time, as the client reads. A client
  that stops reading pauses the generator instead of filling memory.

Each yielded event has these fields:

| Field | |
| --- | --- |
| `data` | the payload: a string is sent as is, anything else as JSON. A value with no JSON form, such as `undefined`, throws |
| `event` | the name, read by `addEventListener(name)` instead of `onmessage` |
| `id` | a string or a number; the browser sends the last one back as `Last-Event-ID` when it reconnects |
| `retry` | milliseconds the browser waits before reconnecting; a whole number, 0 or more |

A multi-line `data` is framed correctly. `event` and `id` must fit on one
line: a value with a line break or a NUL throws a `TypeError`, because sending
it would add a field the stream never meant to send.

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

The generator receives an `AbortSignal` that fires when the stream is over:
the client left, the response was discarded, `until` fired, or the
generator ended. A generator that yields regularly needs nothing more: when
the client leaves, its loop ends and its `finally` runs. **A generator that
can go quiet must pass the signal on** to whatever it waits for, such as a
queue with no traffic, or it waits inside an `await` forever.
[Streaming](/docs/concepts/streaming/#a-generator-must-yield-or-wait-on-the-signal)
shows how.

A generator that throws ends the stream where it stood. The response has
already gone, so the error goes to the application's `reportError` with
`source: "stream"` (or is printed as `[tetsu] stream failed:` without one). A
`finally` or an `onEnd` that throws is reported the same way.

### Stopping the server

A stopping server waits for every response in flight, and a stream never
finishes on its own. `until` ends it from outside: pass the `draining`
signal of `@tetsujs/lifecycle`, and clients reconnect to another server.
See [Streams and sockets](/docs/guides/health-and-shutdown/#streams-and-sockets).

## Knowing what a stream did

An access log records a stream when it starts, so a long feed shows as a fast
`200`. `onEnd` reports how the stream actually ended:

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
    }),
});
// { events: 412, bytes: 38104, durationMs: 2401882.6, reason: "cancelled" }
```

`reason` is `"ended"` (the generator finished), `"cancelled"` (the client left,
the response was discarded, or `until` fired) or `"failed"` (the generator
threw). `events` counts the events, not the keep-alives or the opening;
`bytes` counts everything sent. The summary has no request id: add what
identifies the request yourself, from `ctx`. A stream that was never sent
reports nothing.

## Other formats: stream()

`sse()` is `stream()` with SSE framing on top. For anything else, such as
NDJSON, CSV or a model's tokens, `stream()` sends the chunks as they are, with
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

`stream()` sends no opening and no keep-alive unless asked, because not every
format has a line a client will ignore. The headers go out with the first
chunk, so a stream that is slow to produce one keeps its client waiting for
the headers too. Yield early, or set a keep-alive the consumer's parser
ignores, such as a blank line:

```ts twoslash
import { stream } from "@tetsujs/sse";
import type { BaseCtx } from "@tetsujs/core";

declare const ctx: BaseCtx;
declare function chunks(signal: AbortSignal): AsyncGenerator<string, void, undefined>;
// ---cut---
const response = stream(ctx, chunks, { keepAlive: { everyMs: 15_000, chunk: "\n" } });
```

## Options

| `sse()` | Default | |
| --- | --- | --- |
| `heartbeatMs` | `15000` | keep-alive interval; `0` turns it off |
| `status` | `200` | |
| `until` | none | a signal that ends the stream, such as `draining` |
| `onEnd` | none | receives the summary when the stream ends |

| `stream()` | Default | |
| --- | --- | --- |
| `contentType` | none | the `content-type` header |
| `status` | `200` | |
| `headers` | none | more response headers |
| `keepAlive` | off | `{ everyMs, chunk }` |
| `until` | none | a signal that ends the stream |
| `onEnd` | none | receives the summary; it counts `chunks` instead of `events` |

The package also exports `frame(event)`, which formats one event as it goes on
the wire, and the types `ServerSentEvent`, `SseOptions`, `SseSummary`,
`SseReason`, `StreamOptions`, `StreamSummary`, `StreamReason` and `KeepAlive`.
