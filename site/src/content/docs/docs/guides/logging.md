---
title: Logging
description: Failures the framework cannot answer through reportError, request logs with accessLog and arrivalLog, request ids that join them, and redaction by the application's logger.
sidebar:
  order: 6
---

This page wires an application's logs: the failures the framework cannot
answer to a client, a line for every request, and the request id that
joins them. The framework has no logger and takes none; where a line goes
and what it contains is up to the application. The examples use
[pino](https://getpino.io), and any logger that takes an object works the
same way.

## Failures nobody can answer

Most failures become a response: a thrown `HttpError` is a `404` or a
`409`, a validation failure is a `422`, and the access log shows them with
their status. Some failures have no response to become — an error no
`onError` hook mapped, an `afterResponse` hook that threw after the
response was sent, a broken stream. By default they are printed with
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

`error` is what was thrown, exactly as it was thrown; see
[Redaction](#redaction) for why that matters. `source` says what failed.
`ctx` is the request's context, typed from the application's hooks, each
field optional, and absent where there was no request.
[Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response)
lists every source.

The receiver is called and never awaited, so a slow log shipper does not
slow down a response.

The same function serves the rest of the process: `onShutdownSignals`
takes it as its `reportError` option, and a
[background job](/docs/guides/background-jobs/) calls it with a source of
its own, such as `{ source: "job", error }`.

## A line for every request

`@tetsujs/request-log` writes request logs. `accessLog()` is an
`afterResponse` hook that writes one record as each response goes out,
`404`s and failures included. `arrivalLog()` is a `beforeParse` hook that
writes one as each request comes in:

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

An access record looks like this:

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

`route` is the route that answered, and is absent on a `404`. When
something was thrown, the record adds `thrown` with the error's name,
never its message; the full error goes to `reportError`, joined by the
request id. When the client left before the response was ready, it adds
`aborted: true`.

The arrival line is for requests that never finish — a handler that hangs,
a process that dies half-way — and leave no access record. It doubles the
lines, so skip it behind a proxy that already logs every arrival.

Neither record holds headers, bodies or query strings; `path` is the one
field that carries what the client sent, so keep secrets out of URLs. A
route that needs more in its line — a user id, a tenant — logs it itself.
[`@tetsujs/request-log`](/docs/packages/request-log/) lists every field.

Both hooks write on the request's own path, so a `write` that blocks delays
the response. Use a logger that does not wait on its output, such as
`pino(pino.destination({ sync: false }))`, and call `logger.flush()` among
the closers when the process stops.

The same records feed [request metrics](/docs/guides/metrics/).

## Joining the lines of one request

`requestId()` gives every request an id: `ctx.requestId` in the context,
and an `x-request-id` header on the response. Mount it before the request
logs, and they pick it up; `reportError` reads it from `ctx?.requestId`.
The arrival line, the access line and a failure report of one request then
share one id, and a client reporting a problem can quote it from the
response header.

Order matters: a hook sees only what the hooks before it contributed. See
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

Mount `scope` on the application, after `requestId()`, so that every
request has it, a `404` included:
`createApp({ hooks: { beforeParse: [id, scope] }, routes })`. Placed before
`id`, it does not compile. It uses `enterWith` rather than `run` because a
hook is not handed the rest of the request as a callback.

With pino, a `mixin` puts the id on every line the application writes:

```ts twoslash
declare const current: () => { requestId: string } | undefined;
// ---cut---
import pino from "pino";

const logger = pino({ mixin: () => ({ ...current() }) });
```

Return a copy, as above: pino merges each line's fields into the object
`mixin` returns, so the stored object itself would carry one line's fields
into the next. Keep the store to ids and trace labels. What a decision
depends on — a user, a role — belongs in `ctx`, where the compiler checks
that it is there.

## Redaction

`reportError` receives the error as it was thrown. A database error may
carry the query parameters; a broken response contract carries the
validator's `issues`, and some validators quote the rejected value. The
framework formats none of it into a string, so the logger's own redaction
still sees those fields:

```ts twoslash
import pino from "pino";
// ---cut---
const logger = pino({
  redact: ["err.issues", "err.parameters"],
});
```

pino's error serializer keeps an error's own fields, such as `issues` on a
`ResponseContractError` or a `parameters` field a database driver adds, and
`redact` replaces them with `[Redacted]`.

The request logs need none of this: their records hold no headers, bodies
or query strings, and `thrown` is only a name.
