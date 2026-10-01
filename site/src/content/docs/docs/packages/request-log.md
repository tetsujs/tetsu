---
title: "@tetsujs/request-log"
description: Request logs as hooks — a record when a request is done, and a record when it arrives.
sidebar:
  order: 7
  label: "@tetsujs/request-log"
---

`@tetsujs/request-log` writes a record for every request as its response goes
out, and optionally another as it arrives. Each is a hook that hands the record
to a `write` function you give it, so it fits any logger.

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

`accessLog()` is one `afterResponse` hook. Every request, a `404` and a failure
included, produces one record:

```ts
{ method: "GET", path: "/items/42", route: "/items/:id", status: 200, durationMs: 12.418, requestId: "…" }
```

| Field | |
| --- | --- |
| `method` | the request method |
| `path` | the pathname the client asked for; never the query |
| `route` | the route as declared, `/items/:id` where `path` is `/items/42`; absent when no route matched |
| `status` | the status of the response |
| `durationMs` | milliseconds from `ctx.startedAt` to the response, rounded to the microsecond |
| `thrown` | the `name` of what was thrown, if anything was, or its `typeof` when it is not an `Error` |
| `aborted` | `true` when the connection closed before the response was ready; absent otherwise |
| `requestId` | the id from [`requestId()`](/docs/packages/request-id/), when it ran before this hook |

Group a dashboard by `route`: it stays one value however many ids are
requested. `path` is what to read on a `404`, where there is no route.

## Arrival records

A request whose handler hangs, or whose process dies, never gets an access
record. `arrivalLog()` writes one as the request comes in, so there is a trace
that it came at all:

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

It is one `beforeParse` hook and doubles the log lines, so mount it only where
that trace is wanted. Its place in `beforeParse` matters: after `requestId()`,
the record carries the id; after `cors()`, preflights get no record.

## Options

`accessLog()` and `arrivalLog()` take one option:

| Option | Default | |
| --- | --- | --- |
| `write` | `console.log` | receives each record |

`write` receives the record object, not a string, so a structured logger gets
the fields as they are. The package exports the types `AccessRecord`,
`ArrivalRecord`, `AccessLogOptions`, `ArrivalLogOptions`, `LogOptions`,
`AccessLogHook` and `ArrivalLogHook`.

## Notes

- **No headers, bodies or query strings** go into a record, and there is no
  option to add them. `thrown` is the error's name, never its message. `path`
  carries what the client sent, so keep secrets out of URLs.
- **For the full error,** pass `reportError` to `createApp` and join its
  reports to the records by `ctx?.requestId`. See [Logging](/docs/guides/logging/).
- **Records are written on the request's path,** so a `write` that blocks
  delays the response. Use a logger that buffers; see
  [Logging](/docs/guides/logging/#a-line-for-every-request).
- **`durationMs` does not include writing the response to the socket.** For a
  stream, the record is written when the stream starts, so a long feed shows as
  a fast `200`. `onEnd` of [`@tetsujs/sse`](/docs/packages/sse/#knowing-what-a-stream-did)
  reports how a stream actually ended.
- **`aborted: true`** means the client left, or a forced stop cut the
  connection. The record keeps the status the server answered. For nginx's
  view, use `record.aborted ? 499 : record.status`.

## Metrics

A record has what request metrics need (method, route, status and
duration), so a metrics registry can be fed from the same `write`. Label by
`route`, never by `path`: `path` creates a new series for every id, and for
every path a scanner tries. The [Metrics guide](/docs/guides/metrics/)
feeds a Prometheus histogram this way and serves it on a port of its own.
