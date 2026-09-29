# @tetsujs/request-log

Request logs: a line when a request arrives, and a line when it is done.

```bash
bun add @tetsujs/request-log
```

## Usage

```ts
import { requestId } from "@tetsujs/request-id";
import { accessLog, arrivalLog } from "@tetsujs/request-log";

const id = requestId();
const finished = accessLog({ write: (record) => logger.info(record, "request finished") });

createApp({
  hooks: { beforeParse: [id], afterResponse: [finished] },
  routes,
});
```

`accessLog()` is one `afterResponse` hook, and it is the log most
applications want: every request — a `404` and a failure included —
produces one record as its response goes out:

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

## The line of an arrival

A request whose handler hangs, or whose process dies half-way, never gets
an access record. `arrivalLog()` writes one when the request comes in, so
there is a trace that it came at all:

```ts
const arrived = arrivalLog({ write: (record) => logger.info(record, "request received") });

createApp({
  hooks: { beforeParse: [id, arrived], afterResponse: [finished] },
  routes,
});
```

```ts
{ method: "GET", path: "/items/42", requestId: "…" }
```

It is one `beforeParse` hook, and it doubles the lines, so it is mounted
only where that trace is wanted — behind a proxy that already logs every
arrival it is not. Where it sits in `beforeParse` decides what it sees:
after `requestId()`, the record carries the id; after `cors()`, a preflight
is answered before it runs and gets no line. The two records of one
request are joined by their `requestId`; the route is on the access record,
where it can be grouped by.

## Options

| `accessLog()`, `arrivalLog()` | Default | |
| --- | --- | --- |
| `write` | `console.log` | receives each record |

## Notes

- **No headers, bodies or query strings in a record,** and no option to add
  them — nothing sensitive has to be stripped from a place it is never put.
  `thrown` is the error's class, never its message, for the same reason.
  `path` is the pathname, the one field carrying what the client sent, so
  keep secrets out of URLs.
- **`durationMs` is measured from `ctx.startedAt`,** which the core reads
  before any hook runs. It measures the pipeline; writing the response to
  the socket is not included.
- **Both lines are written on the request's own path** — the arrival line
  before the handler, the access line as the response goes out. A writer
  that blocks delays the response; a logger that buffers, like pino, is
  the kind to hand them.
- **A failure's full error** — message, stack — is not in either record:
  pass `reportError` to `createApp`, and join the report to the records by
  `ctx?.requestId`.
- **A connection that closed before the response was ready** — a client
  that left, or a forced stop that cut it — is recorded with
  `aborted: true` and the status the server answered, which the client
  never got. nginx logs `499` there
  instead; that view is `record.aborted ? 499 : record.status`, and the
  status is kept because a server failing while its clients gave up would
  otherwise leave no `5xx` behind.

## Metrics

A record has everything request metrics need — the method, the route, the
status, the duration — so a registry is fed from the same `write`. With
[`prom-client`](https://github.com/siimon/prom-client):

```ts
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

Label by `route`, never by `path`: `route` is `/users/:id` whatever was
requested, while `path` makes a new series for every id — and for every
path a scanner tries, which is why a request no route answered is counted
as `unmatched`. The histogram's `_count` is the request count, so no
counter is needed beside it. The balancer's probes are left out in `write`,
by the route the record carries: they arrive every few seconds and would
outweigh the traffic.

The registry is served by an application of its own, on a port the
balancer does not route to — Prometheus reads it, the API's clients do not,
and it stays out of the API's document, logs and rate limits:

```ts
import { register } from "prom-client";

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

One [`onShutdownSignals`](../lifecycle#several-servers) stops both servers.
`collectDefaultMetrics()` adds the process's own — memory, CPU, event loop
lag, garbage collection. They are named `nodejs_*` although the process is
Bun: `prom-client` reads them through the Node APIs Bun implements.
