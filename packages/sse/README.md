# @tetsujs/sse

Server-sent events from an async generator, and the same machinery for any
other streamed format.

```bash
bun add @tetsujs/sse
```

## Usage

```ts
import { sse } from "@tetsujs/sse";

route({
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

`sse()` sets the SSE headers, frames every event, sends a keep-alive
comment every 15 seconds so proxies do not close an idle connection, and
pulls events one at a time — a client that stops reading stops the
generator instead of filling memory.

An event:

```ts
yield {
  data: { price: 42 }, // a string is sent as is, anything else as JSON
  event: "tick",       // the name for addEventListener
  id: "1712",          // sent back as Last-Event-ID when the browser reconnects
  retry: 3_000,        // how long the browser waits before reconnecting
};
```

## Resuming

A browser that lost the connection reconnects with the last id it saw.
`lastEventId(ctx)` reads it, so the stream can continue from there:

```ts
import { lastEventId, sse } from "@tetsujs/sse";

handler: (ctx) =>
  sse(ctx, async function* () {
    for await (const item of history.since(lastEventId(ctx))) {
      yield { data: item, id: item.id };
    }
  }),
```

## Cleaning up

The generator receives an `AbortSignal` that fires when the stream is over
— the client left, the response was discarded, or the generator finished.

A generator that yields regularly needs nothing more: when the client
leaves, its loop ends and its `finally` runs. **A generator that can go
quiet must pass the signal on** to whatever it waits for — a queue with no
traffic, a poll of something unchanged. Otherwise it waits forever and is
never cleaned up:

```ts
sse(ctx, async function* (signal) {
  const queue = await broker.subscribe("prices", { signal });

  try {
    for await (const price of queue) {
      yield { data: price, id: price.at };
    }
  } finally {
    await queue.close();
  }
});
```

A generator that throws ends the stream where it stood, and the error goes
to the application's `reportError` with `source: "stream"` — printed as
`[tetsu] stream failed:` when there is none. The response has already
left, so there is no `onError` to hand it to.

## Knowing what a stream did

An access log sees a stream when it starts, so it records a long feed as a
fast `200`. `onEnd` reports how it actually ended:

```ts
sse(ctx, feed, {
  onEnd: (summary) => logger.info({ ...summary, requestId: ctx.requestId }, "stream closed"),
});
// { events: 412, bytes: 38104, durationMs: 2401882.6, reason: "cancelled" }
```

`reason` is `"ended"` (the generator finished), `"cancelled"` (the client
left, or the response was discarded) or `"failed"` (the generator threw).

## Other formats: `stream()`

`sse()` is `stream()` with SSE framing on top. For anything else — NDJSON,
CSV, a model's tokens — `stream()` takes the chunks as they are, with the
same backpressure, signal and summary:

```ts
import { stream } from "@tetsujs/sse";

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
```

`stream()` sends no keep-alives unless asked, because not every format has
a line a client will ignore:

```ts
{ keepAlive: { everyMs: 15_000, chunk: "\n" } }
```

## Options

| `sse()` | Default | |
| --- | --- | --- |
| `heartbeatMs` | `15000` | keep-alive interval; `0` turns it off |
| `status` | `200` | |
| `onEnd` | — | receives the summary when the stream ends |

| `stream()` | Default | |
| --- | --- | --- |
| `contentType` | none | the `content-type` header |
| `status` | `200` | |
| `headers` | — | more response headers |
| `keepAlive` | off | `{ everyMs, chunk }` |
| `onEnd` | — | receives the summary; it counts `chunks` instead of `events` |
