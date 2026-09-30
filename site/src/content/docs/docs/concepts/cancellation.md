---
title: Cancellation and timeouts
description: Stopping work when the client leaves with ctx.req.signal, adding a deadline with AbortSignal.timeout, and why the framework has no timeout of its own.
sidebar:
  order: 13
---

Work started for a request can outlive the reason for it: the client
disconnects, or an upstream call takes longer than anyone will wait. This
page covers the request's own signal, deadlines built from the platform's
signals, and why the framework does not answer a slow request with a
timeout of its own.

## The request's signal

`ctx.req.signal` is the platform's `AbortSignal` for the request, and it
aborts when the client disconnects. Passed to the work the handler starts,
it stops that work when nobody is left to receive the answer:

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
take a signal. A stream that stops producing when the client leaves is the
same idea, and `@tetsujs/sse` passes the signal to its generator for you —
see [Streaming](/docs/concepts/streaming/).

## Deadlines

A deadline comes from the platform too. `AbortSignal.timeout()` aborts
after a delay, and `AbortSignal.any()` combines it with the request's
signal, so the work stops at whichever comes first:

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

An aborted call rejects, and the rejection travels the error path like any
error the handler throws. A deadline that expired rejects with a
`DOMException` named `TimeoutError`; left as it is, it answers `500` and is
reported as `unhandled`. An `onError` hook turns it into the answer you
mean:

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
handed the signal and are watching it; everything else runs on. A query
started without one runs to completion however long it takes, and a loop
that never looks at the signal keeps looping.

So the signal goes to every call that may take long, and a loop of your
own checks `signal.aborted`, or calls `signal.throwIfAborted()`, between
steps. A step that cannot be interrupted is at least not followed by the
next one.

## Why there is no framework timeout

A framework timeout would answer `503` once a request takes too long, and
the framework does not offer one, because it could not keep the promise
that answer makes.

JavaScript cannot interrupt a running function. When the timeout fires,
the handler is still running — mid-query, mid-payment — and it goes on
after the client has been told the request failed. The client, reading
`503` as "nothing happened, try again", retries, and the second attempt
runs next to the first. For a payment that is a double charge.

A deadline that stops the work has to be passed to the work, which only the
handler can do: it knows which calls are safe to abandon and what a
half-done operation leaves behind. `AbortSignal.any()` with
`AbortSignal.timeout()` is that deadline, in one line, where the handler
can see it.

What the framework does leave to the platform is the connection. Bun
closes a connection that sends nothing for its `idleTimeout`, set where the
application is served, and `ctx.server.timeout(ctx.req, seconds)` changes
it for one request — a long upload, a slow report:

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

For a retry that must not repeat its effect, the client sends an
idempotency key and the handler remembers what it answered — a decision
about the domain, and the handler's to make.
