---
title: Logging
description: Failures the framework cannot answer through reportError, request logs with accessLog and arrivalLog, request ids that join them, and redaction by the application's logger.
sidebar:
  order: 6
---

This page wires an application's logs: the failures the framework cannot
answer to a client, a line for every request, and the request id that
joins them. The examples use [pino](https://getpino.io); any logger that
takes an object works the same way.

The framework has no logger of its own and writes no lines of its own,
except the failures it cannot return to a client. It takes no logger
either: there is no interface with levels to adapt one to. Where a line
goes, what it contains and how it is redacted is the application's.

## Failures nobody can answer

Most failures become a response. A thrown `HttpError` is an answer — a
`404`, a `409` — and a validation failure is a `422`; these are the
client's business, and they appear in the access log with their status.

Some failures have no response to become: an error no `onError` hook
mapped, a handler that broke its response contract, an `afterResponse`
hook that threw after the response was sent, a WebSocket handler, a
stream that broke half-way. By default they are printed with
`console.error`. Given `reportError`, `createApp` sends them there instead:

```ts twoslash
declare const routes: object;
// ---cut---
import type { FailureReport } from "@tetsujs/core";
import { createApp } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import pino from "pino";

const logger = pino();

const reportError = ({ source, error, ctx }: FailureReport<{ requestId?: string }>) =>
  logger.error({ err: error, source, requestId: ctx?.requestId }, "tetsu");

createApp({
  hooks: { beforeParse: [requestId()] },
  reportError,
  routes,
});
```

A report has three fields:

- **`error`** is what was thrown, exactly as it was thrown — not formatted,
  not truncated. See [Redaction](#redaction) for why that matters.
- **`source`** says what failed, as a code to branch on.
- **`ctx`** is the request's context, typed from the application's own
  hooks, each field optional, since the failure may have come before the
  hook that adds it ran. It is absent where there was no request.

| `source` | What failed |
| --- | --- |
| `unhandled` | an error no `onError` hook answered, and not an `HttpError`; the request got a `500` |
| `response` | a handler broke its response contract — a status its map does not declare, a body its schema rejects |
| `onError` | an `onError` hook threw; the next one, or the default mapping, answered instead |
| `errorResponse` | the error path kept failing until nothing could answer, and the request got a bare `500` |
| `afterResponse` | an `afterResponse` hook threw; the response had already gone |
| `websocket` | a WebSocket handler threw, or an endpoint's `until` function did |
| `stream` | a streamed body's source threw |
| `shutdown` | a closer threw while the process was stopping (`@tetsujs/lifecycle`) |

The type of `source` stays open: a package reporting a failure of its own
names its own source.

The receiver is called in place and never awaited, so a slow log shipper
does not become a client's latency. A receiver that throws, or returns a
promise that rejects, is reported on `console.error` together with the
failure it was given — the one place left for it.

The same receiver serves the rest of the process. `onShutdownSignals`
takes it for a closer that fails, and a background job hands it its own
failures, so all of them reach one logger in one shape:

```ts twoslash
import type { FailureReport } from "@tetsujs/core";
declare const logger: { error(fields: object, message: string): void };
declare const server: import("bun").Server<unknown>;
declare const db: { close(): void };
declare function sweep(): Promise<void>;
const reportError = ({ source, error, ctx }: FailureReport<{ requestId?: string }>) =>
  logger.error({ err: error, source, requestId: ctx?.requestId }, "tetsu");
// ---cut---
import { onShutdownSignals } from "@tetsujs/lifecycle";

onShutdownSignals(server, { close: [() => db.close()], reportError });

await sweep().catch((error) => reportError({ source: "job", error }));
```

See [Errors](/docs/concepts/errors/) for what becomes a response and what
does not, and [Background jobs](/docs/guides/background-jobs/).

## A line for every request

`@tetsujs/request-log` writes request logs. `accessLog()` is an
`afterResponse` hook that writes one record as each response goes out —
a `404` and a failure included. `arrivalLog()` is a `beforeParse` hook
that writes one as each request comes in:

```ts twoslash
declare const routes: object;
import pino from "pino";
const logger = pino();
// ---cut---
import { createApp } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import { accessLog, arrivalLog } from "@tetsujs/request-log";

const id = requestId();
const arrived = arrivalLog({ write: (record) => logger.info(record, "request received") });
const finished = accessLog({ write: (record) => logger.info(record, "request finished") });

createApp({
  hooks: { beforeParse: [id, arrived], afterResponse: [finished] },
  routes,
});
```

An access record carries the method, the path that was asked for, the
route that answered — `/notes/:id` where the path was `/notes/42`, absent
on a `404` — the status, the duration, and the request id:

```json
{
  "method": "GET",
  "path": "/notes/42",
  "route": "/notes/:id",
  "status": 200,
  "durationMs": 12.418,
  "requestId": "0b7c6f0e-…"
}
```

A request where something was thrown adds `thrown`, the error's `name` and
never its message — `Error` for a subclass that does not set a name of its
own. A request whose client left before the response was
ready adds `aborted: true`. The full error is not in the record: it goes to
`reportError`, and the two are joined by the request id.

The arrival line is for requests that never finish — a handler that hangs,
a process that dies half-way — which leave no access record. It doubles
the lines, so mount it where that trace is wanted; behind a proxy that
already logs every arrival, it is not.

Neither record holds headers, bodies or query strings, and there is no
option to add them: nothing sensitive has to be removed from a place it is
never put. `path` is the one field that carries what the client sent, so
keep secrets out of URLs. A route that needs more in its line — a user id,
a tenant — logs it itself, or a hook of your own writes the line.

Both hooks write on the request's own path: the arrival line before the
handler runs, the access line as the response goes out. A `write` that
blocks delays the response, so hand them a logger that does not wait on
its output — `pino(pino.destination({ sync: false }))`, flushed with
`logger.flush()` among the closers when the process stops.

The same records feed request metrics — see [Metrics](/docs/guides/metrics/).

## Joining the lines of one request

`requestId()` gives every request an id: `ctx.requestId` for the rest of
the request, and an `x-request-id` header on the response. Mounted before
them, the request logs pick it up, and `reportError` reads it from
`ctx?.requestId`. The arrival line, the access line and a failure of one
request then share one value, and a client that reports a problem can
quote the id from the response header.

The order is what makes it work. A hook of the application sees what the
hooks before it contributed, and the request logs read the id only when
`requestId()` ran first. The package reference is in
[`@tetsujs/request-id`](/docs/packages/request-id/).

### The id deeper than the handler

Code that never receives `ctx` — a repository several calls down — can
still log with the id, through `AsyncLocalStorage`:

```ts twoslash
import { AsyncLocalStorage } from "node:async_hooks";
import { hook, type Requires } from "@tetsujs/core";

const store = new AsyncLocalStorage<{ requestId: string }>();

export const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
  store.enterWith({ requestId: ctx.requestId });
});

export const current = () => store.getStore();
```

Mount `scope` after `requestId()`, on the application, so that every
request has it, a `404` included:
`createApp({ hooks: { beforeParse: [id, scope] }, routes })`. Placed
before `id`, it does not compile. It uses `enterWith` rather than `run`
because a hook is not handed the rest of the request as a callback, and it
costs about 12 ns a request.

With pino, a `mixin` puts the id on every line the application writes,
from wherever it writes it:

```ts twoslash
declare const current: () => { requestId: string } | undefined;
// ---cut---
import pino from "pino";

const logger = pino({ mixin: () => ({ ...current() }) });
```

The copy matters. pino merges each line's own fields into the object
`mixin` returns, so returning the stored object itself would carry one
line's fields into every later line of the request. Keep the store to ids
and trace labels: what a decision depends on — a user, a role — belongs in
`ctx`, where the compiler checks that it is there.

## Redaction

`reportError` receives the error as it was thrown. A database error may
carry the query and its parameters; a broken response contract carries the
validator's `issues`, and some validators quote the rejected value in
them. Nothing is formatted into a string on the way, so the logger's own
serializers and redaction see the fields they know:

```ts twoslash
import pino from "pino";
// ---cut---
const logger = pino({
  redact: ["err.issues", "err.parameters"],
});
```

pino's error serializer keeps an error's own fields — `err.issues` of a
`ResponseContractError`, a `parameters` field a database driver puts on
its errors — and
`redact` replaces them with `[Redacted]` in the line. A framework that
formatted the error first would have put those values into a message
string, past any redaction.

The request logs need none of this: a record holds no headers, bodies or
query strings, and `thrown` is only a name.
