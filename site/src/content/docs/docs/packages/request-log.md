---
title: "@tetsujs/request-log"
description: Request logs as hooks — a record when a request is done, and a record when it arrives.
sidebar:
  order: 7
  label: "@tetsujs/request-log"
---

`@tetsujs/request-log` writes a record for every request: one as the response
goes out, and, where it is wanted, one as the request comes in. Each is a hook,
and each record goes to a `write` function you give it, so it fits any logger.

```bash
bun add @tetsujs/request-log
```

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import pino from "pino";

const logger = pino();
const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";

const id = requestId();
const finished = accessLog({ write: (record) => logger.info(record, "request finished") });

createApp({
  hooks: { beforeParse: [id], afterResponse: [finished] },
  routes,
});
```

`accessLog()` is one `afterResponse` hook, and it is the log most applications
want: every request, a `404` and a failure included, produces one record as its
response goes out.

```ts
{
  method: "GET",
  path: "/items/42",     // what the client asked for
  route: "/items/:id",   // the route that answered; absent on a 404
  status: 200,
  durationMs: 12.418,
  thrown: "TypeError",   // the class of what was thrown, if anything was
  aborted: true,         // the connection closed before the response was ready
  requestId: "…",        // when requestId() ran before it
}
```

| Field | |
| --- | --- |
| `method` | the request method |
| `path` | the pathname the client asked for, identifiers and all; never the query |
| `route` | the route as declared, `/items/:id` where `path` is `/items/42`; absent when nothing matched |
| `status` | the status of the response |
| `durationMs` | milliseconds inside the pipeline, rounded to the microsecond |
| `thrown` | the `name` of what was thrown, when something was; `typeof` for a value that is not an `Error` |
| `aborted` | `true` when the connection closed before the response was ready; absent otherwise |
| `requestId` | the id from [`requestId()`](/docs/packages/request-id/), when it ran before this hook |

`path` and `route` answer different questions. On a `404`, `path` is the only
interesting thing in the line. `route` is what the application did, and a
dashboard can group by it without growing a series per identifier.

## The line of an arrival

A request whose handler hangs, or whose process dies half-way, never gets an
access record. `arrivalLog()` writes one when the request comes in, so there is
a trace that it came at all:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";
import pino from "pino";

const logger = pino();
const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
const id = requestId();
const finished = accessLog({ write: (record) => logger.info(record, "request finished") });
// ---cut---
import { arrivalLog } from "@tetsujs/request-log";

const arrived = arrivalLog({ write: (record) => logger.info(record, "request received") });

createApp({
  hooks: { beforeParse: [id, arrived], afterResponse: [finished] },
  routes,
});
```

```ts
{ method: "GET", path: "/items/42", requestId: "…" }
```

It is one `beforeParse` hook, and it doubles the lines, so it is mounted only
where that trace is wanted. Behind a proxy that already logs every arrival it
is not. Where it sits in `beforeParse` decides what it sees: after
`requestId()`, the record carries the id; after `cors()`, a preflight is
answered before it runs and gets no line. The two records of one request are
joined by their `requestId`. The route is on the access record, where it can be
grouped by.

## Options

Both `accessLog()` and `arrivalLog()` take the same option.

| Option | Default | |
| --- | --- | --- |
| `write` | `console.log` | receives each record |

`write` takes the record itself, not a string, so a structured logger is handed
the fields as they are. The records are typed: `AccessRecord` and
`ArrivalRecord`, with `AccessLogOptions`, `ArrivalLogOptions` and `LogOptions`
for the options, and `AccessLogHook` and `ArrivalLogHook` for the hooks.

## Notes

- **No headers, bodies or query strings in a record,** and no option to add
  them: nothing sensitive has to be stripped from a place it is never put.
  `thrown` is the error's name, never its message, for the same reason. `path`
  is the pathname, the one field carrying what the client sent, so keep secrets
  out of URLs.
- **`durationMs` is measured from `ctx.startedAt`,** which the core reads
  before any hook runs. It measures the pipeline; writing the response to the
  socket is not included.
- **Both lines are written on the request's own path:** the arrival line before
  the handler, the access line as the response goes out. A writer that blocks
  delays the response, and a logger that buffers, like pino, is the kind to hand
  them.
- **A stream is recorded when it starts.** The access line is written as the
  response goes to Bun, which for a streamed body is the moment it begins, so a
  long feed appears as a fast `200`. See [`@tetsujs/sse`](/docs/packages/sse/#knowing-what-a-stream-did)
  for `onEnd`, which reports how a stream actually ended.
- **A failure's full error,** message and stack, is not in either record. Pass
  `reportError` to `createApp` and join the report to the records by
  `ctx?.requestId`. See [Logging](/docs/guides/logging/).
- **A connection that closed before the response was ready** is recorded with
  `aborted: true` and the status the server answered, which the client never
  got. That is a client that left, or a forced stop that cut the connection.
  nginx logs `499` there instead. That view is `record.aborted ? 499 :
  record.status`, and the status is kept because a server failing while its
  clients gave up would otherwise leave no `5xx` behind.

## Metrics

A record has everything request metrics need, the method, the route, the status
and the duration, so a registry is fed from the same `write`. With
[`prom-client`](https://github.com/siimon/prom-client):

```ts twoslash
import { accessLog } from "@tetsujs/request-log";
// ---cut---
import { collectDefaultMetrics, Histogram } from "prom-client";

collectDefaultMetrics();

const duration = new Histogram({
  name: "http_request_duration_seconds",
  help: "How long a request took, from arrival to response",
  labelNames: ["method", "route", "status"],
});

const probes = new Set(["/livez", "/readyz"]);

const measured = accessLog({
  write: (record) => {
    if (record.route !== undefined && probes.has(record.route)) return;

    duration.observe(
      { method: record.method, route: record.route ?? "unmatched", status: record.status },
      record.durationMs / 1000,
    );
  },
});
```

Label by `route`, never by `path`. `route` is `/users/:id` whatever was
requested, while `path` makes a new series for every id, and for every path a
scanner tries, which is why a request no route answered is counted as
`unmatched`. The histogram's `_count` is the request count, so no counter is
needed beside it. The balancer's probes are left out in `write`, by the route
the record carries: they arrive every few seconds and would outweigh the
traffic.

The registry is served by an application of its own, on a port the balancer
does not route to. Prometheus reads it, the API's clients do not, and it stays
out of the API's document, logs and rate limits:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { accessLog } from "@tetsujs/request-log";
import { register } from "prom-client";

declare const routes: Parameters<typeof createApp>[0]["routes"];
declare const pool: { end(): Promise<void> };
const measured = accessLog();
// ---cut---
const metricsController = controller("Metrics", () => ({
  metrics: route({
    method: "GET",
    path: "/metrics",
    handler: async () =>
      new Response(await register.metrics(), {
        headers: { "content-type": register.contentType },
      }),
  }),
}));

const api = Bun.serve({ ...createApp({ hooks: { afterResponse: [measured] }, routes }), port: 3000 });
const internal = Bun.serve({ ...createApp({ routes: metricsController() }), port: 9464 });

onShutdownSignals([api, internal], { close: [() => pool.end()] });
```

One [`onShutdownSignals`](/docs/packages/lifecycle/#several-servers) stops both
servers. `collectDefaultMetrics()` adds the process's own: memory, CPU, event
loop lag, garbage collection. They are named `nodejs_*` although the process is
Bun, because `prom-client` reads them through the Node APIs Bun implements.
The [Metrics guide](/docs/guides/metrics/) covers this end to end.
