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
produces one record once its response has gone:

```ts
{
  method: "GET",
  path: "/items/42",     // what the client asked for
  route: "/items/:id",   // the route that answered; absent on a 404
  status: 200,
  durationMs: 12.418,
  thrown: "TypeError",   // the class of what was thrown, if anything was
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
- **The arrival line is written on the request's own path.** A writer that
  blocks delays the request; a logger that buffers, like pino, is the kind
  to hand it. The access line is written after the response, outside the
  client's latency.
- **A failure's full error** — message, stack — is not in either record:
  pass `reportError` to `createApp`, and join the report to the records by
  `ctx?.requestId`.

## Metrics

A record has everything request metrics need — count, status, duration —
so a metrics registry is fed from the same `write`. Label by `route`, never
by `path`: `route` is `/users/:id` whatever was requested, while `path`
makes a new series for every id.

```ts
accessLog({
  write: (record) => {
    const route = record.route ?? "unmatched";

    requests.labels(record.method, route, String(record.status)).inc();
    latency.labels(record.method, route).observe(record.durationMs);
  },
});
```
