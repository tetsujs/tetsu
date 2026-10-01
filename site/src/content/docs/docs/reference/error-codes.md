---
title: Framework error codes
description: Every status and error code the framework produces by itself, the envelope they share, the default code of each status, and the error classes and functions.
sidebar:
  order: 5
---

Every error the framework answers by itself uses one envelope. This page
lists those errors, the default code of each status, and the classes and
functions behind them. [Errors](/docs/concepts/errors/) explains the model.

## The envelope

```json
{ "status": 413, "message": "Body exceeds the configured limit", "error": "BODY_TOO_LARGE" }
```

| Field | Type | |
| --- | --- | --- |
| `status` | `number` | the HTTP status, repeated |
| `message` | `string` | for people; it may change, so never match on it |
| `error` | `string` | the code, in `UPPER_SNAKE_CASE`; branch on this field |
| `issues` | `{ message: string; path: (string \| number)[] }[]` | validation failures only; `path` starts with the request part |

## Codes the framework produces

| Status | `error` | `message` | When |
| --- | --- | --- | --- |
| `400` | `MALFORMED_JSON` | Body is not valid JSON | a `json` body does not parse |
| `400` | `MALFORMED_FORM` | Body is not a valid form | a `form` body does not parse |
| `404` | `NOT_FOUND` | Not Found | no route matches the path and there is no `fallback` |
| `405` | `METHOD_NOT_ALLOWED` | Method Not Allowed | the path exists but not the method; `Allow` lists the path's methods |
| `413` | `BODY_TOO_LARGE` | Body exceeds the configured limit | the body is over `maxBodySize` |
| `422` | `VALIDATION_FAILED` | Validation failed | a request part failed its schema; carries `issues`; `400` with `validation: { status: 400 }` |
| `426` | `UPGRADE_REQUIRED` | Upgrade Required | a WebSocket endpoint's path was requested without a handshake |
| `500` | `INTERNAL_SERVER_ERROR` | Internal Server Error | an error that is not an `HttpError` and no `onError` hook answered; a broken response contract; a stream returned bare |

[`@tetsujs/rate-limit`](/docs/packages/rate-limit/) adds `RATE_LIMITED`,
`429` unless its `status` option says otherwise, with `retryAfter` in
seconds in the body and a `retry-after` header.

Every failure above reaches the application's `onError` hooks before it
is answered: as an `HttpError`, or, for a `500`, as the error that caused
it. Only the application's hooks run for a `404` and a `405`.

Two answers reach no hook:

- the last-resort `500`, sent when the error path itself kept failing;
- a body larger than Bun's own `maxRequestBodySize`, which Bun refuses with
  a bare `413` and no envelope. `createApp` raises that cap above the
  largest `maxBodySize` when it needs to.

### WebSocket close codes

| Code | When |
| --- | --- |
| `1001` | the endpoint's `until` signal fired (going away) |
| `1007` | on an endpoint with `schema.message`, a frame is binary, not valid JSON, or fails the schema, and there is no `invalid` handler |
| `1011` | the message schema threw or rejected instead of reporting issues |

## Default codes

An `HttpError` without a body, and `errorBody()` or `httpError()` without
an `error`, take the code and message from the status. The message is the
reason phrase. The code is that phrase in upper snake case, apostrophes
dropped. A status not in this list gets `HTTP <status>` and
`HTTP_<status>`.

| Status | `error` | Status | `error` |
| --- | --- | --- | --- |
| `400` | `BAD_REQUEST` | `421` | `MISDIRECTED_REQUEST` |
| `401` | `UNAUTHORIZED` | `422` | `UNPROCESSABLE_CONTENT` |
| `402` | `PAYMENT_REQUIRED` | `423` | `LOCKED` |
| `403` | `FORBIDDEN` | `424` | `FAILED_DEPENDENCY` |
| `404` | `NOT_FOUND` | `425` | `TOO_EARLY` |
| `405` | `METHOD_NOT_ALLOWED` | `426` | `UPGRADE_REQUIRED` |
| `406` | `NOT_ACCEPTABLE` | `428` | `PRECONDITION_REQUIRED` |
| `407` | `PROXY_AUTHENTICATION_REQUIRED` | `429` | `TOO_MANY_REQUESTS` |
| `408` | `REQUEST_TIMEOUT` | `431` | `REQUEST_HEADER_FIELDS_TOO_LARGE` |
| `409` | `CONFLICT` | `451` | `UNAVAILABLE_FOR_LEGAL_REASONS` |
| `410` | `GONE` | `500` | `INTERNAL_SERVER_ERROR` |
| `411` | `LENGTH_REQUIRED` | `501` | `NOT_IMPLEMENTED` |
| `412` | `PRECONDITION_FAILED` | `502` | `BAD_GATEWAY` |
| `413` | `CONTENT_TOO_LARGE` | `503` | `SERVICE_UNAVAILABLE` |
| `414` | `URI_TOO_LONG` | `504` | `GATEWAY_TIMEOUT` |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | `505` | `HTTP_VERSION_NOT_SUPPORTED` |
| `416` | `RANGE_NOT_SATISFIABLE` | `506` | `VARIANT_ALSO_NEGOTIATES` |
| `417` | `EXPECTATION_FAILED` | `507` | `INSUFFICIENT_STORAGE` |
| `418` | `IM_A_TEAPOT` | `508` | `LOOP_DETECTED` |
| | | `510` | `NOT_EXTENDED` |
| | | `511` | `NETWORK_AUTHENTICATION_REQUIRED` |

The framework's own `413` uses `BODY_TOO_LARGE`, not the default
`CONTENT_TOO_LARGE`.

## Throwing

| Export | Signature | |
| --- | --- | --- |
| `HttpError` | `new HttpError(status: number, body?: unknown)` | answered with `status`; no body gives the envelope, a string replaces the envelope's `message`, any other value is sent as it is |
| `httpError` | `httpError(status: number, error?: string, message?: string): HttpError` | an `HttpError` whose body is the envelope |
| `errorBody` | `errorBody(status: number, error?: string, message?: string): ErrorBody` | the envelope as a plain object, for a `Response` of your own |
| `ValidationError` | `new ValidationError(status: number, issues: readonly ValidationIssue[])` | an `HttpError` with `error: "VALIDATION_FAILED"` and `issues` |

```ts twoslash
import { errorBody, httpError, HttpError } from "@tetsujs/core";
// ---cut---
new HttpError(404);
// { "status": 404, "message": "Not Found", "error": "NOT_FOUND" }

new HttpError(403, "Not your order");
// { "status": 403, "message": "Not your order", "error": "FORBIDDEN" }

httpError(409, "ALREADY_SHIPPED", "Order already shipped");
// { "status": 409, "message": "Order already shipped", "error": "ALREADY_SHIPPED" }

Response.json({ ...errorBody(429, "RATE_LIMITED"), retryAfter: 30 }, { status: 429 });
// { "status": 429, "message": "Too Many Requests", "error": "RATE_LIMITED", "retryAfter": 30 }
```

An `HttpError` has `status`, `body`, and a `message` for logs. A
`ValidationError` adds `issues`.

## Reported failures

| Export | Signature | |
| --- | --- | --- |
| `ResponseContractError` | `new ResponseContractError(message: string, issues?: readonly unknown[])` | what `reportError` receives with `source: "response"` when a handler breaks its response contract |
| `reportFailure` | `reportFailure(ctx: BaseCtx, source: FailureSource, error: unknown): void` | sends a report to the application's `reportError`, or prints it when there is none |

A report is `{ source, error, ctx? }`. The framework's sources are
`unhandled`, `response`, `onError`, `errorResponse`, `afterResponse`,
`websocket`, `stream` and `shutdown`, and a package may add its own. See
[Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response).
Without a `reportError`, each report is printed on `console.error` with a
`[tetsu]` prefix.
