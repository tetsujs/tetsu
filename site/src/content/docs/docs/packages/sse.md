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

- sets `content-type: text/event-stream` and `cache-control: no-cache`, and
  `x-accel-buffering: no`, so nginx, which buffers a proxied response by
  default, passes each event on as it is written;
- opens with a comment, `: open`, so the headers go out at once rather than
  with the first event;
- sends a `: ping` comment every 15 seconds, and sets the request's idle
  timeout above that, so neither Bun nor a proxy closes an idle connection
  (see [Idle connections](#idle-connections));
- asks the generator for one event at a time, as the client reads. A client
  that stops reading pauses the generator instead of filling memory.

A header some other proxy needs, such as `no-transform`, which asks a proxy
not to change the body, goes on `ctx.out.headers`. The framework lays it
over the response `sse()` returns, and set from a hook, it covers a whole
group or application:

```ts twoslash
import { hook } from "@tetsujs/core";
// ---cut---
const noTransform = hook.beforeHandle((ctx) => {
  ctx.out.headers.set("cache-control", "no-cache, no-transform");
});
```

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

`onShutdownSignals()` takes the server, and the server is built from the
routes, so the handler reads the signal when a request comes in, after the
server and the signal exist:

```ts twoslash
declare function feed(signal: AbortSignal): AsyncGenerator<{ data: string }>;
// ---cut---
import { createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { sse } from "@tetsujs/sse";

const live = route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: shutdown.draining }),
});

const server = Bun.serve({ ...createApp({ routes: { live } }), port: 3000 });
const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

A controller built from its dependencies takes the signal as a function;
see [Streams and sockets](/docs/guides/health-and-shutdown/#streams-and-sockets).

## Idle connections

Bun closes a connection that sends nothing for its `idleTimeout`, 10
seconds unless the server sets another, and the first heartbeat of a quiet
feed comes after 15. So when the stream starts, `sse()` sets its own
request's timeout to the heartbeat and ten seconds more, with
`ctx.server.timeout()`. Every other request keeps the server's setting.

It sets the timeout rather than raising it: Bun does not say what the
server's `idleTimeout` is, so a longer one, or `0`, is replaced for these
requests too. A client that stops reading is then let go after the
stream's timeout, and a heartbeat over four minutes is cut at 255
seconds. The timeout is set as the stream is read, after the handler has
returned, so it also replaces one the handler set itself, such as the
`server.timeout(req, 0)` of Bun's own guide. A generator that wants
another sets it, since it starts later.

Where the stream cannot set it, the server's `idleTimeout` decides. A
feed with `heartbeatMs: 0` is closed once it stays quiet longer. Over
HTTP/3, Bun ignores a request's own timeout: set `idleTimeout` above the
heartbeat. On a unix socket it ignores it too, and its types do not take
`idleTimeout` with `unix`: keep the heartbeat under 8 seconds there, since
Bun checks idleness every 4 and its default of 10 can end a connection
after 8. Bun waits 255 seconds at most, so a heartbeat over four minutes
keeps no connection open.

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

A keep-alive sets the request's idle timeout, as the heartbeat of `sse()`
does. Without one, Bun closes a stream that writes nothing for the server's
`idleTimeout`. A stream that should arrive as it is written, behind nginx,
sends `x-accel-buffering: no` in `headers`, as `sse()` does on its own.

## In the OpenAPI document

The [generated document](/docs/packages/openapi/) calls a body JSON unless
the route says otherwise. Name the stream's type in the response map, and
the same for `stream()`, with its own type:

```ts twoslash
import { route } from "@tetsujs/core";
import { sse } from "@tetsujs/sse";

declare function feed(signal: AbortSignal): AsyncGenerator<{ data: string }>;
// ---cut---
const live = route({
  method: "GET",
  path: "/feed",
  schema: { response: { 200: { contentType: "text/event-stream" } } },
  handler: (ctx) => sse(ctx, feed),
});
```

OpenAPI 3.1 cannot describe the events one by one, so the stream is
documented by its type alone.

## Options

| `sse()` | Default | |
| --- | --- | --- |
| `heartbeatMs` | `15000` | keep-alive interval, up to 2³¹ − 1; `0` turns it off, and `NaN`, `Infinity` or a negative throws a `TypeError` |
| `status` | `200` | |
| `until` | none | a signal that ends the stream, such as `draining` |
| `onEnd` | none | receives the summary when the stream ends |

| `stream()` | Default | |
| --- | --- | --- |
| `contentType` | none | the `content-type` header |
| `status` | `200` | |
| `headers` | none | more response headers |
| `keepAlive` | off | `{ everyMs, chunk }`; `everyMs` follows the rules of `heartbeatMs` |
| `until` | none | a signal that ends the stream |
| `onEnd` | none | receives the summary; it counts `chunks` instead of `events` |

The package also exports `frame(event)`, which formats one event as it goes on
the wire, and the types `ServerSentEvent`, `SseOptions`, `SseSummary`,
`SseReason`, `StreamOptions`, `StreamSummary`, `StreamReason` and `KeepAlive`.
