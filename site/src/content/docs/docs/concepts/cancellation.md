---
title: Cancellation and timeouts
description: Stopping work when the client leaves with ctx.req.signal, adding a deadline with AbortSignal.timeout, and why the framework has no timeout of its own.
sidebar:
  order: 13
---

Work started for a request can outlive the reason for it: the client
disconnects, or an upstream call takes longer than anyone will wait. The
platform's `AbortSignal` handles both.

## The request's signal

`ctx.req.signal` aborts when the client disconnects. Pass it to the work
the handler starts, and that work stops when nobody is left to receive the
answer:

```ts twoslash
import { route } from "@tetsujs/core";
interface Rates { base: string; rates: Record<string, number> }
// ---cut---
route({
  method: "GET",
  path: "/rates",
  handler: async (ctx) => {
    const res = await fetch("https://rates.example.com/latest", { signal: ctx.req.signal });
    const rates: Rates = await res.json();

    return rates;
  },
});
```

`fetch`, Bun's own APIs, `node:timers/promises` and most database drivers
take a signal. `@tetsujs/sse` passes one to its generator for you; see
[Streaming](/docs/concepts/streaming/).

## Deadlines

`AbortSignal.timeout()` aborts after a delay, and `AbortSignal.any()`
combines it with the request's signal, so the work stops at whichever comes
first:

```ts twoslash
import { route } from "@tetsujs/core";
declare const upstream: { fetch(options: { signal: AbortSignal }): Promise<{ id: string }> };
// ---cut---
route({
  method: "GET",
  path: "/quotes",
  handler: async (ctx) => {
    const signal = AbortSignal.any([ctx.req.signal, AbortSignal.timeout(5_000)]);

    return await upstream.fetch({ signal });
  },
});
```

An expired deadline rejects with a `DOMException` named `TimeoutError`.
Left alone, it answers `500` and is reported as `unhandled`. An `onError`
hook turns it into the answer you mean:

```ts twoslash
import { errorBody, hook } from "@tetsujs/core";
// ---cut---
const upstreamTimeout = hook.onError((ctx) => {
  if (ctx.error instanceof DOMException && ctx.error.name === "TimeoutError") {
    return Response.json(errorBody(504, "UPSTREAM_TIMEOUT"), { status: 504 });
  }
});
```

## A signal stops only the work it was passed to

Aborting a signal does not stop the handler. It stops the calls that were
given the signal; everything else runs on. A query started without one
runs to completion, and a loop that never checks the signal keeps looping.

So pass the signal to every call that may take long, and in a loop of your
own call `signal.throwIfAborted()` between steps.

## Why there is no framework timeout

A framework timeout would answer `503` once a request takes too long. The
framework does not offer one, because JavaScript cannot interrupt a
running function: the handler would keep running, mid-query or
mid-payment, after the client was told the request failed. A client that
retries on `503` would then run the operation twice.

A deadline that really stops the work has to be passed to the work, and
only the handler knows which calls are safe to abandon.
`AbortSignal.any()` with `AbortSignal.timeout()` is that deadline, in one
line. For a retry that must not repeat its effect, the client sends an
idempotency key and the handler remembers what it answered.

## Connection timeouts

Bun closes a connection that sends nothing for its `idleTimeout`, set where
the application is served. `ctx.server.timeout(ctx.req, seconds)` changes
it for one request, such as a long upload or a slow report:

```ts twoslash
import { route } from "@tetsujs/core";
declare const reports: { build(signal: AbortSignal): Promise<{ rows: number }> };
// ---cut---
route({
  method: "POST",
  path: "/reports",
  handler: async (ctx) => {
    ctx.server.timeout(ctx.req, 120);

    return await reports.build(ctx.req.signal);
  },
});
```

An event stream from `@tetsujs/sse` sets its own, above its heartbeat; see
[Idle connections](/docs/packages/sse/#idle-connections). On a unix socket
Bun ignores `ctx.server.timeout()`, and only the server's `idleTimeout`
applies.
