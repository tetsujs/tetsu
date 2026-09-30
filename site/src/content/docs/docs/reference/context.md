---
title: Context fields
description: Every field of ctx, its type and the slot it exists from, with the details of ctx.out, ctx.res, ctx.error and signedCookie, and the context types the core exports.
sidebar:
  order: 4
---

`ctx` is one object per request, handed to every hook and to the handler.
A field is typed where it exists at that point of the request and nowhere
before. [Context and its types](/docs/concepts/context/) explains the
rule.

## Fields

| Field | Type | Exists from | |
| --- | --- | --- | --- |
| `req` | `Request & { cookies?: CookieMap }` | every slot | the request as Bun delivered it |
| `server` | `Bun.Server` | every slot | the real server |
| `out` | `Outgoing` | every slot | what the response will carry — [below](#ctxout) |
| `route` | `RouteInfo` | every slot | the route that matched; optional where none did |
| `startedAt` | `number` | every slot | `performance.now()` when the pipeline took the request |
| `params` | `{ [name]: string }`, or the schema's output | `beforeParse` | raw strings until `validate`, the schema's output from `beforeHandle` |
| `body` | `unknown`, or by `bodyType` | `beforeValidation` | only when the route reads a body; as parsed, then the schema's output from `beforeHandle` |
| `rawBody` | `Uint8Array` | `beforeValidation` | only with `rawBody: true` |
| `query` | the schema's output | `beforeHandle` | only with `schema.query` |
| `headers` | the schema's output | `beforeHandle` | only with `schema.headers` |
| `cookies` | the schema's output | `beforeHandle` | only with `schema.cookies`; signed cookies opened |
| `res` | `Response` / `SentResponse` | `beforeResponse` / `afterResponse` | [below](#ctxres) |
| `error` | `unknown` | `onError` | [below](#ctxerror) |
| a hook's fields | what it returned | the hook after it | typed in the handler for the route's own hooks only |

In `beforeResponse`, `afterResponse` and `onError`, the validated parts and
the hooks' fields are optional: the request may have failed before they
were produced. `params` there is the union of the raw strings and the
schema's output.

The body of a route without `schema.body`, before or after validation, is
typed by `bodyType`:

| `bodyType` | `ctx.body` |
| --- | --- |
| `"json"` | `unknown` |
| `"form"` | `FormBody` — `Record<string, string \| File \| (string \| File)[]>` |
| `"text"` | `string` |
| `"stream"` | `ReadableStream<Uint8Array>` |

### `req`

The request as Bun delivered it, always available. On a request that
matched a route it carries `cookies`, Bun's `CookieMap`: the cookies as
the client sent them, unchecked, and whose changes Bun sends as
`Set-Cookie` with its defaults (`Path=/; SameSite=Lax`). It is absent on
the `404` fallback and in unit tests. `req.signal` aborts when the client
disconnects.

### `server`

The `Bun.Server` handling the request, unwrapped:
`ctx.server.requestIP(ctx.req)` for the client's address,
`ctx.server.timeout(ctx.req, seconds)` for a per-request idle timeout. A
server listening on both IPv4 and IPv6 — Bun's default — reports an IPv4
client as `::ffff:203.0.113.7`. `stop()` and `reload()` are there too, and
have no business inside a request.

### `route`

| Field | Type | |
| --- | --- | --- |
| `method` | `string` | the method the route answers |
| `path` | `string` | the declared path with prefixes joined: `/api/users/:id`, never `/api/users/42` |
| `controller` | `string`, optional | the controller's name; absent for an object literal or a route mounted on its own |
| `name` | `string`, optional | the field the route was declared as; the `operationId` is built from it |

One object per route, built at startup and shared by every request. It is
absent on a `404`, a `405` and a preflight, which have no route. Label logs
and metrics with `path`, not the URL: a label per identifier grows a new
series per user.

### `startedAt`

A monotonic reading in milliseconds, taken before any hook ran.
`performance.now() - ctx.startedAt` is how long the request has been in the
framework. Wall-clock time is `Date.now()`.

## `ctx.out`

| Member | Type | |
| --- | --- | --- |
| `status` | `number \| undefined` | the status of a serialized result; ignored for a `Response` and for errors |
| `headers` | `Headers` | laid over every response that leaves; created on first access |
| `cookies.set` | `(name, value, attributes?) => void` | adds a `set-cookie`; signed when the name is covered; a second `set` of a name replaces the first |
| `cookies.delete` | `(name, attributes?) => void` | expires the cookie; `path` and `domain` must match the ones it was set with |

The attributes are Bun's `CookieInit` without `name` and `value`:
`domain`, `path`, `expires`, `maxAge`, `secure`, `httpOnly`, `sameSite`,
`partitioned`.

`ctx.out.headers` is merged into the response: `set-cookie` appended,
`vary` merged token by token, every other name overwritten. It applies to
serialized results, a handler's `Response`, a hook's short-circuit and
error responses.

On a route with a response map, the handler's `ctx.out` is a
`DeclaredOutgoing<Status>`: `status` can be set only to a declared status,
and reads as any number, since a hook may have set another.

## `ctx.res`

In `beforeResponse`, `ctx.res` is the `Response` about to leave. Returning
a new `Response` replaces it; reading the body there consumes it, so clone
it first (`ctx.res.clone()`).

In `afterResponse`, it is a `SentResponse`: `status`, `statusText`,
`headers`, `ok`, `redirected`, `type` and `url`, with no way to the body —
reading it is a compile error. Read what is needed before the first
`await`: once the response is sent, what nobody read may be gone.

## `ctx.error`

Whatever was thrown, as `unknown`:

| Value | From |
| --- | --- |
| `HttpError` | a hook or handler that threw one; a `404` or `405`; a body that failed to parse or was too large |
| `ValidationError` | a request part failed its schema; `issues` lists them |
| `ResponseContractError` | the handler broke its response contract |
| anything else | an unexpected failure: a `TypeError`, a driver's error |

## Cookies

```ts
function signedCookie(ctx: BaseCtx, name: string): string | undefined
```

The value of a signed cookie, its signature checked, from the request's
`cookie` header — for a hook that runs before `ctx.cookies` exists.
Returns the first value whose signature holds, or `undefined`. Throws
when the application signs no cookies or does not sign `name`. See
[Cookies](/docs/concepts/cookies/#reading-a-signed-cookie-early).

## Types

| Type | |
| --- | --- |
| `BaseCtx` | the fields every slot has: `req`, `server`, `out`, `route?`, `startedAt` |
| `EarlyCtx<Path>` | `BaseCtx` with raw `params` and `route`: `beforeParse` |
| `ValidatedCtx<Path, S>` | the context after validation, from the path and the schemas |
| `HandlerCtx`, `ResponseCtx`, `ErrorCtx` | the context of a handler, a response-slot hook, an `onError` hook |
| `Requires<T>` | `BaseCtx & T`, what a reusable hook declares |
| `Outgoing`, `DeclaredOutgoing<Status>` | `ctx.out` |
| `DeclaredStatus<S>` | the statuses a response map declares |
| `ResponseCookies`, `CookieAttributes`, `CookieOptions` | `ctx.out.cookies`, its attributes, the `cookies` option |
| `RouteInfo` | `ctx.route` |
| `SchemaConfig`, `ResponseEntry` | `schema`, and one status of a response map |
| `BodyType`, `ParsedBody<B>`, `FormBody`, `FormValue` | the body before validation |
| `ExtractParams<Path>` | `"/orders/:id"` → `{ id: string }` |
| `ValidatePath<P>`, `ValidatePrefix<P>`, `PathError<Msg>` | the compile-time path checks |
| `HandlerResult<S>`, `HandlerMustReturn<A>`, `HandlerReturnMarker`, `ValidateResult<R>`, `ResultError<Msg>` | what a handler may return, and the error for a stream |
| `AnySchema`, `InferInput<S>`, `InferOutput<S>`, `Standard*` | Standard Schema, and JSON Schema conversion (`JsonSchemaDirection`) |
| `Socket`, `SocketData`, `SocketState`, `MessageOf<S>`, `WsSchemaConfig` | a WebSocket endpoint's socket, its data and messages |
| `RouteMap`, `RouteSignature`, `RoutesOf<T>`, `RouteTableEntry` | the routes an application serves, in its type and in `app.entries` |
| `GroupNode`, `GroupOptions`, `GroupConfig`, `GroupHooks` | `group()` |
| `Mountable` | a controller with an `[onMount](app)` method |
| `ErrorBody`, `ValidationIssue` | the envelope and one issue — see [Framework error codes](/docs/reference/error-codes/) |
| `FailureReport`, `FailureSource`, `ReportError` | what `reportError` receives |
