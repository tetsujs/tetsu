# @tetsujs/request-id

A request id on every request and response, and an access log line for
every finished request.

```bash
bun add @tetsujs/request-id
```

## Usage

```ts
import { accessLog, requestId } from "@tetsujs/request-id";

const id = requestId();
const log = accessLog();

createApp({
  hooks: { beforeParse: [id], afterResponse: [log] },
  routes,
});
```

Each is one hook: `requestId()` in `beforeParse`, `accessLog()` in
`afterResponse`.

Every response gets an `x-request-id` header, and every request — a `404`
and a failure included — produces one record:

```ts
{
  method: "GET",
  path: "/items/42",     // what the client asked for
  route: "/items/:id",   // the route that answered; absent on a 404
  status: 200,
  durationMs: 12.418,
  thrown: "TypeError",   // the class of what was thrown, if anything was
  requestId: "…",
}
```

`accessLog()` writes records with `console.log`; pass `write` to send them
to your logger instead:

```ts
accessLog({ write: (record) => logger.info(record, "request") });
```

## Reading the id in a handler

`requestId()` adds `ctx.requestId`. Mounted on the application it is there
at runtime, but not in a route's types — the application does not know
which routes it will hold. To have it typed, mount it on the route:

```ts
const id = requestId();

route({
  method: "GET",
  path: "/orders",
  hooks: { beforeParse: [id] },
  handler: (ctx) => logger.info({ requestId: ctx.requestId }, "listing"),
  //                                   ^? string
});
```

or declare it where it is read, with `Requires<{ requestId: string }>`, and
the compiler checks that something provides it. A hook of the application
mounted after `requestId()` sees it typed too — that is how the
`AsyncLocalStorage` recipe below works.

## Options

| `requestId()` | Default | |
| --- | --- | --- |
| `header` | `"x-request-id"` | the header the id is written to, and read from when trusted |
| `trustIncoming` | `false` | use the id the client sent; enable only behind a proxy that sets the header |
| `generate` | `crypto.randomUUID` | how a new id is made |

| `accessLog()` | Default | |
| --- | --- | --- |
| `write` | `console.log` | receives each record |

## Notes

- **No headers, bodies or query strings in a record,** and no option to add
  them — nothing sensitive has to be stripped from a place it is never put.
  `thrown` is the error's class, never its message, for the same reason.
  `path` is the one field carrying what the client sent, so keep secrets
  out of URLs.
- **`durationMs` is measured from `ctx.startedAt`,** which the core reads
  before any hook runs. It measures the pipeline; writing the response to
  the socket is not included.
- **Errors and the log line share an id** when failures go to your logger
  too: pass `reportError` to `createApp` and log `ctx?.requestId` with the
  error — see Logging in the core README. The record keeps to the error's
  class; the full error, with its message and stack, is the report's.

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

## The id deeper than the handler

Code that never receives `ctx` — a repository several calls down — can
still read the id through `AsyncLocalStorage`. It is a few lines, so this
package leaves it to you:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { hook, type Requires } from "@tetsujs/core";

const store = new AsyncLocalStorage<{ requestId: string }>();

export const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
  store.enterWith({ requestId: ctx.requestId });
});

export const current = () => store.getStore();
```

Mount `scope` after `requestId()`, on the application so that every
request has it, a `404` included:

```ts
createApp({ hooks: { beforeParse: [id, scope] }, routes });
```

The order is what the compiler checks: a hook of the application or of a
group sees what the hooks before it at the same level contributed, and
`scope` placed before `id` does not compile.

It uses `enterWith` rather than `run` because a hook is not handed the
rest of the request as a callback, and it costs about 12 ns a request.
With pino, `mixin: () => ({ ...current() })` puts the id on every line the
application writes, from wherever it writes it. The copy matters: pino
merges each line's own fields into the object `mixin` returns, so handing
it the stored object itself would carry one line's fields into every line
after it for the rest of the request. Keep the store to things like ids and
trace labels: anything a decision depends on — a user, a role — belongs in
`ctx`, where the compiler checks it is there.
