---
title: Errors
description: How HttpError and httpError become responses, the error envelope, how onError hooks map errors at every level, and where failures that cannot become a response go.
sidebar:
  order: 9
---

An error thrown anywhere in a request becomes a response. This page covers
the errors you throw, the shape every error response has, `onError` hooks
that answer errors your own way, and `reportError`, which receives the
failures no response can carry.

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

The status is always yours to choose. `httpError(status, error, message)`
is the usual way to throw. With `new HttpError(status, body)`, the second
argument decides the body:

| `body` | The response body |
| --- | --- |
| none | the envelope for the status |
| a string | the envelope, with the string as its `message` |
| anything else | the value itself, as JSON |

Anything thrown that is not an `HttpError`, such as a `TypeError` or a
driver's error, answers `500` with the envelope and nothing of the error
itself, and goes to [`reportError`](#failures-that-cannot-become-a-response).

## The envelope

Every error the framework produces, and every `HttpError` without a body of
its own, has one shape:

```json
{ "status": 404, "message": "Not Found", "error": "NOT_FOUND" }
```

- `status` repeats the HTTP status, for a client that kept only the
  payload.
- `error` is the machine-readable code in `UPPER_SNAKE_CASE`. Branch on it.
- `message` is for people and may change. Never match on it.

By default the message is the status's reason phrase, and the code is that
phrase in upper snake case: `Unprocessable Content` is
`UNPROCESSABLE_CONTENT`.

A validation failure adds `issues`, one per rejected value, with a `path`
that starts at the request part; see
[Validation errors](/docs/concepts/validation/#validation-errors).

`errorBody(status, error, message)` builds the same envelope as a plain
object, to add fields of your own or to answer with a `Response` of your
own:

```ts twoslash
import { errorBody, hook, HttpError } from "@tetsujs/core";
declare const maintenance: { on: boolean; until: string };
// ---cut---
const closed = hook.beforeParse(() => {
  if (maintenance.on) {
    throw new HttpError(503, { ...errorBody(503, "MAINTENANCE"), until: maintenance.until });
  }
});
```

Thrown, it still reaches the `onError` hooks; a returned `Response` does
not.

## The framework's own failures

The framework raises its own failures as `HttpError`s in the same
envelope: `MALFORMED_JSON` or `MALFORMED_FORM` for a body that does not
parse, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `BODY_TOO_LARGE`, `VALIDATION_FAILED`, and
`INTERNAL_SERVER_ERROR` for anything unexpected.
[Framework error codes](/docs/reference/error-codes/) lists every one,
those of the packages included. All of them reach the application's
`onError` hooks, the `404` and `405` too, so one hook can decide the format
of every error.

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
about HTTP: the service throws `OrderNotFound`, and the hook decides it is
a `404`.

`onError` hooks mount on a route, a group or the application, and run
from the route outwards, the opposite of the other slots (see
[Groups and mounting](/docs/concepts/groups-and-mounting/#application-hooks)).
The first `Response` wins. When none answers, an `HttpError` gets its own
status and body, and anything else a `500`.

- **It returns a `Response` or nothing.** Returning an object is a compile
  error.
- **Validated parts and fields added by hooks are optional.** The error
  may have come before validation or before the hook that adds a field
  ran, so narrow before reading them.
- **A hook that throws is skipped.** Its error goes to `reportError` with
  `source: "onError"`, and the next hook, or the default mapping, answers
  the original error.
- **Its response goes the rest of the way out.** It passes the
  `beforeResponse` hooks that have not run yet, gets `ctx.out.headers`, and
  is seen by `afterResponse`.
- **Only the application's hooks see `404`, `405` and preflights.** No
  route is behind them, so a group's `onError` never runs for them.

## An error format of your own

An `onError` hook on the application replaces the format for every
failure: an `HttpError` you threw, a validation or body failure, an
unmatched path or method, a rate limit's refusal, and an unexpected error.

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

`reportError` only hears of a failure no `onError` hook answered. So a hook
that answers unexpected errors reports them itself, with `reportFailure`.
Without that line, a lost database connection answers in your format and
never reaches the error tracker.

The generated document does not read that hook. Tell
[`@tetsujs/openapi`](/docs/packages/openapi/#an-error-format-of-your-own)
the same format with its `errors` option, and test the two against each
other with
[`assertDescribed`](/docs/packages/openapi/#testing-against-the-document).

## Failures that cannot become a response

Some failures have no response to become: an `afterResponse` observer that
throws after the response has gone, a WebSocket handler, a stream whose
generator breaks mid-body, an error no `onError` hook answered. These are
the only things the framework logs, and by default they go to
`console.error`. Pass `reportError` to `createApp` to receive them
yourself:

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

A report carries:

- `error`: what was thrown, untouched, so the logger's redaction still
  applies.
- `ctx`: the request's context, with the fields your hooks add typed as
  optional. Absent where there was no request: a WebSocket event, a
  shutdown.
- `source`: what failed.

| `source` | What failed |
| --- | --- |
| `unhandled` | an error no `onError` hook answered, and not an `HttpError`; the request got a `500` |
| `response` | a handler broke its response contract: an undeclared status, a body its schema rejects |
| `onError` | an `onError` hook threw; the next one, or the default mapping, answered instead |
| `errorResponse` | the error path kept failing, and the request got a plain `500` |
| `afterResponse` | an `afterResponse` observer threw; the response had already gone |
| `websocket` | a WebSocket handler threw, a message schema threw instead of reporting issues, or an endpoint's `until` function threw |
| `stream` | a streamed body's generator threw, or its `onEnd` did (`@tetsujs/sse`) |
| `shutdown` | a closer threw while the process was stopping (`@tetsujs/lifecycle`) |

An `HttpError` no hook answered is not reported: it is an answer, not a
failure.

The receiver is called in place and never awaited, so the error path never
waits on a log shipper. If it throws or its promise rejects, that error is
printed to `console.error` with the original report.

`reportFailure(ctx, source, error)` sends a report the way the framework
does, for code that meets a failure it cannot answer: a hook package, a
background task started from a handler, or the `onError` hook above.
`source` can be any string. With a context from `testCtx()`, which has no
application behind it, the report is printed.
