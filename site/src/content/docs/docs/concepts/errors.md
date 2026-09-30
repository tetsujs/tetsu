---
title: Errors
description: How HttpError and httpError become responses, the error envelope, how onError hooks map errors at every level, and where failures that cannot become a response go.
sidebar:
  order: 9
---

An error thrown anywhere in a request becomes a response. This page covers
the errors you throw, the one shape every error response has, the
`onError` hooks that turn errors into responses of your own, and
`reportError`, which receives the failures no response can carry.

## Throwing an error

A handler or a hook refuses a request by throwing. `HttpError` carries a
status, and `httpError()` builds one with an error code of your own:

```ts twoslash
import { HttpError, httpError, route } from "@tetsujs/core";
interface Order { id: number; ownerId: number; shipped: boolean }
declare const orders: { find(id: string): Order | undefined };
// ---cut---
route({
  method: "POST",
  path: "/orders/:id/ship",
  handler: (ctx) => {
    const order = orders.find(ctx.params.id);

    if (!order) throw new HttpError(404);
    // { "status": 404, "message": "Not Found", "error": "NOT_FOUND" }

    if (order.shipped) throw httpError(409, "ALREADY_SHIPPED", "Order already shipped");
    // { "status": 409, "message": "Order already shipped", "error": "ALREADY_SHIPPED" }

    return order;
  },
});
```

The status is always yours to choose: the framework never picks a business
status for you. The same `throw` works from every hook slot that runs
before the response, from the handler, and from a `beforeResponse` hook.

What reaches the client depends on the second argument of `HttpError`:

| `new HttpError(status, body)` | The response body |
| --- | --- |
| no `body` | the envelope for the status |
| a string | the envelope, with the string as its `message` |
| anything else | the value itself, as JSON |

A body you wrote is a contract of your own, so the framework does not
rewrite it. `httpError(status, error, message)` is the envelope with both
halves stated, and the usual way to throw.

Anything thrown that is not an `HttpError` — a `TypeError`, a driver's
error — answers `500` with the envelope and nothing of the error itself,
and goes to [`reportError`](#failures-that-cannot-become-a-response).

## The envelope

Every error the framework produces, and every `HttpError` without a body of
its own, leaves in one shape:

```json
{ "status": 404, "message": "Not Found", "error": "NOT_FOUND" }
```

- `status` repeats the HTTP status inside the body, so a client that kept
  only the payload — a log line, a queued retry, a rejected promise passed
  up a call stack — still knows what happened.
- `error` is the machine-readable code in `UPPER_SNAKE_CASE`, and the field
  to branch on.
- `message` is for people and may be reworded at any time. Never match on
  it.

Both default to the status. The message is the reason phrase, and the code
is that phrase in upper snake case: `Unprocessable Content` is
`UNPROCESSABLE_CONTENT`. A status without a phrase — a private `499` —
gets `HTTP 499` and `HTTP_499`.

A validation failure adds `issues`, one per rejected value, with a `path`
that starts at the request part it came from:

```json
{
  "status": 422,
  "message": "Validation failed",
  "error": "VALIDATION_FAILED",
  "issues": [{ "message": "Too small: expected number to be >=1", "path": ["body", "qty"] }]
}
```

The `message` of an issue is the validator's own wording, and it differs
between Zod, Valibot, TypeBox and the rest; clients should branch on
`path`. The status is `422` by default, or `400` with
`createApp({ validation: { status: 400 } })`.

`errorBody(status, error, message)` builds the same envelope as a plain
object, for a hook that answers with a `Response` of its own rather than
throwing:

```ts twoslash
import { errorBody, hook } from "@tetsujs/core";
declare const maintenance: { on: boolean; until: string };
// ---cut---
const closed = hook.beforeParse(() => {
  if (maintenance.on) {
    return Response.json(
      { ...errorBody(503, "MAINTENANCE"), until: maintenance.until },
      { status: 503 },
    );
  }
});
```

## The framework's own failures

The framework raises its own failures as `HttpError`s in the same envelope:

| Status | `error` | When |
| --- | --- | --- |
| `400` | `MALFORMED_JSON` | a JSON body does not parse |
| `400` | `MALFORMED_FORM` | a form body does not parse |
| `404` | `NOT_FOUND` | no route matches the path |
| `405` | `METHOD_NOT_ALLOWED` | the path exists, the method does not; `Allow` lists the methods |
| `413` | `BODY_TOO_LARGE` | the body is larger than `maxBodySize` |
| `422` | `VALIDATION_FAILED` | a request part failed its schema |
| `426` | `UPGRADE_REQUIRED` | a WebSocket path was requested without a handshake |
| `500` | `INTERNAL_SERVER_ERROR` | anything unexpected |

`@tetsujs/rate-limit` refuses with `429` and `RATE_LIMITED`, plus a
`retryAfter` field. [Framework error codes](/docs/reference/error-codes/)
lists every one with its message.

All of them reach the application's `onError` hooks, exactly as an error
you throw does. A `404` for an unmatched path and a `405` for an
unmatched method included: they are failures like any other, so one hook
decides the format of every error the application answers with.

## `onError` hooks

An `onError` hook runs when a stage throws. It sees the error as
`ctx.error`, and answers with a `Response`, or returns nothing to pass the
error on:

```ts twoslash
import { errorBody, hook } from "@tetsujs/core";
class OrderNotFound extends Error {
  constructor(readonly orderId: number) { super(`order ${orderId} not found`); }
}
// ---cut---
const domainErrors = hook.onError((ctx) => {
  if (ctx.error instanceof OrderNotFound) {
    return Response.json(errorBody(404, "ORDER_NOT_FOUND"), { status: 404 });
  }
});
```

This is how a domain error becomes a response without the domain knowing
about HTTP. The service throws `OrderNotFound`; the hook, mounted where
the services are used, decides that it is a `404`.

`onError` hooks are mounted on a route, a group or the application, like
every other hook. They run innermost first — the route's, then each
group's from the nearest outwards, then the application's — so the most
specific hook gets to answer before a general one. The first `Response`
wins. When none answers, the default mapping does: the status and body of
an `HttpError`, or a `500`.

Some things to know about the slot:

- **It returns a `Response` or nothing.** An object is a compile error
  rather than a body: `{ status: 409 }` returned from here would otherwise
  become a `500` without a word.
- **The context is optional past the early fields.** The error may have
  come before validation or before the hook that contributes a field, so
  those fields are optional and the hook narrows before it reads them.
- **A hook that throws is passed over.** Its own error goes to
  `reportError` with `source: "onError"`, and the next hook — or the
  default mapping — answers the original error instead.
- **Its response goes the rest of the way out.** It passes the
  `beforeResponse` hooks that have not run yet, gets `ctx.out.headers`, and
  is seen by the `afterResponse` observers.
- **Only the application's hooks see protocol failures.** A `404`, a `405`
  and a preflight have no route behind them, so they run with the
  application's hooks alone — a group's `onError` never sees them.

## An error format of your own

An `onError` hook on the application replaces the format for the whole
application. Every failure reaches it: an `HttpError` you threw, a
validation or body failure, an unmatched path or method, a rate limit's
refusal, and an error nothing expected.

```ts twoslash
import type { ErrorBody } from "@tetsujs/core";
import { hook, HttpError, reportFailure } from "@tetsujs/core";

export const inOurFormat = hook.onError((ctx) => {
  const { error } = ctx;

  if (error instanceof HttpError) {
    const { status, error: code, ...rest } = error.body as ErrorBody;

    return Response.json({ code, ...rest }, { status });
  }

  reportFailure(ctx, "unhandled", error);

  return Response.json(
    { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" },
    { status: 500 },
  );
});
```

An error a hook answers is one nothing else reports: `reportError` hears
of a failure only when no `onError` hook answered it. So the hook that
answers the unexpected ones reports them itself, with `reportFailure`.
Left out, a lost database connection answers in your format and never
reaches the error tracker.

The generated document is built from the routes, not from that hook, so
[`@tetsujs/openapi`](/docs/packages/openapi/#an-error-format-of-your-own)
is told the same format with its `errors` option. The hook and `errors`
describe one format in two places, and a function cannot be read for the
shape it returns. A test holds them together: provoke each kind of
failure, the unexpected one included, and check the response against the
document with `assertDescribed`:

```ts twoslash
import { hook, HttpError, reportFailure } from "@tetsujs/core";
import type { ErrorBody } from "@tetsujs/core";
const inOurFormat = hook.onError((ctx) => {
  const { error } = ctx;
  if (error instanceof HttpError) {
    const { status, error: code, ...rest } = error.body as ErrorBody;
    return Response.json({ code, ...rest }, { status });
  }
  reportFailure(ctx, "unhandled", error);
  return Response.json({ code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" }, { status: 500 });
});
declare const api: object;
// ---cut---
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { openapi, type ErrorFormat } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";
import { test } from "bun:test";

const errors: ErrorFormat = {
  schema: ({ error, message, fields }) => ({
    type: "object",
    required: ["code", "message", ...Object.keys(fields)],
    properties: {
      code: error ? { type: "string", const: error } : { type: "string" },
      message: { type: "string", ...(message ? { examples: [message] } : {}) },
      ...fields,
    },
  }),
  discriminator: "code",
};

const boom = route({ method: "GET", path: "/boom", handler: () => { throw new Error("boom"); } });
const app = createApp({ hooks: { onError: [inOurFormat] }, routes: [api, boom] });
const request = serve(app);
const { document } = openapi(app, { info: { title: "Orders", version: "1.0.0" }, errors });

test("failures are what the document says", async () => {
  await assertDescribed(document, "POST /orders", await request("/orders", { method: "POST", body: "{}" }));
  await assertDescribed(document, "GET /boom", await request("/boom"));
});
```

## Failures that cannot become a response

Some failures have no response to become: an `afterResponse` observer that
throws after the response has gone, a WebSocket handler, a stream whose
generator breaks mid-body, an error no `onError` hook answered. The
framework writes no log lines of its own except these, and by default they
go to `console.error`. Pass `reportError` to `createApp`, and they go to
you instead:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
import pino from "pino";
declare const routes: object[];
// ---cut---
const logger = pino();

const app = createApp({
  hooks: { beforeParse: [requestId()] },
  reportError: ({ source, error, ctx }) =>
    logger.error({ err: error, source, requestId: ctx?.requestId }, "tetsu"),
  routes,
});
```

A report carries three things:

- `error` — what was thrown, untouched: not formatted, not truncated, so
  the logger's redaction sees the fields it knows.
- `ctx` — the request's context, typed from the application's own hooks
  with each field optional, since the failure may have come before the hook
  that adds it ran. Absent where there was no request: a WebSocket event, a
  shutdown.
- `source` — what failed:

| `source` | What failed |
| --- | --- |
| `unhandled` | an error no `onError` hook answered, and not an `HttpError`; the request got a `500` |
| `response` | a handler broke its response contract — an undeclared status, a body its schema rejects |
| `onError` | an `onError` hook threw; the next one, or the default mapping, answered instead |
| `errorResponse` | the error path kept failing until nothing could answer, and the request got a bare `500` |
| `afterResponse` | an `afterResponse` observer threw; the response had already gone |
| `websocket` | a WebSocket handler threw, a message schema failed rather than rejected, or an endpoint's `until` function threw |
| `stream` | a streamed body's generator threw, or its `onEnd` did (`@tetsujs/sse`) |
| `shutdown` | a closer threw while the process was stopping (`@tetsujs/lifecycle`) |

An `HttpError` that no hook answered is not reported: it is an answer, not
a failure, and it goes to the client as it is.

The receiver is called in place and never awaited — the error path must
not wait on a log shipper. A receiver that throws, or returns a promise
that rejects, is itself printed to `console.error` together with the
report it was handed.

`reportFailure(ctx, source, error)` sends a report the way the framework
does, for code of your own that meets a failure it cannot answer: a hook
package, a background task started from a handler, or an `onError` hook
that answers the unexpected errors, as above. `source` is any string, so a
package names its own. A context built outside a request, such as
`testCtx()` in a unit test, has no application behind it, and the report
is printed.
