---
title: Context fields
description: Every field of ctx, its type and the slot it exists from, the details of ctx.out, ctx.res and ctx.error, signedCookie, and the context types.
sidebar:
  order: 4
---

`ctx` is one object per request, handed to every hook and to the handler.
A field is typed from the slot where it exists, and not before.
[Context and its types](/docs/concepts/context/) explains the rule.

## Fields

| Field | Type | Exists from | |
| --- | --- | --- | --- |
| `req` | `Request & { cookies?: CookieMap }` | every slot | the request as Bun delivered it |
| `server` | `Bun.Server` | every slot | the server handling the request |
| `out` | `Outgoing` | every slot | what the response will carry, [below](#ctxout) |
| `route` | `RouteInfo` | every slot | the route that matched; absent where none did |
| `startedAt` | `number` | every slot | `performance.now()` when the request entered the framework |
| `params` | `{ [name]: string }`, or the schema's output | `beforeParse` | raw strings until validation, the schema's output from `beforeHandle` |
| `body` | `unknown`, or by `bodyType` | `beforeValidation` | only when the route reads a body; as parsed, then the schema's output from `beforeHandle` |
| `rawBody` | `Uint8Array` | `beforeValidation` | only with `rawBody: true` |
| `query` | the schema's output | `beforeHandle` | only with `schema.query` |
| `headers` | the schema's output | `beforeHandle` | only with `schema.headers` |
| `cookies` | the schema's output | `beforeHandle` | only with `schema.cookies`; signed cookies opened |
| `res` | `Response` / `SentResponse` | `beforeResponse` / `afterResponse` | [below](#ctxres) |
| `error` | `unknown` | `onError` | [below](#ctxerror) |
| a hook's fields | what it returned | the hook after it | typed in the handler for the route's own hooks only |

In `beforeResponse`, `afterResponse` and `onError`, the validated parts and
the hooks' fields are optional, since the request may have failed before
they existed. `params` there is either the raw strings or the schema's
output.

Without `schema.body`, `ctx.body` is typed by `bodyType`: `unknown` for
`"json"`, `FormBody` (`Record<string, string | File | (string | File)[]>`)
for `"form"`, `string` for `"text"`, and `ReadableStream<Uint8Array>` for
`"stream"`.

### `req`

On a request that matched a route, `req.cookies` is Bun's `CookieMap`: the
cookies as the client sent them, unchecked. Bun sends changes to it as
`Set-Cookie` with its defaults (`Path=/; SameSite=Lax`). It is absent on
the `404` fallback and in unit tests. `req.signal` aborts when the client
disconnects.

### `server`

The `Bun.Server` itself: `ctx.server.requestIP(ctx.req)` gives the
client's address, `ctx.server.timeout(ctx.req, seconds)` sets a
per-request idle timeout. A server listening on both IPv4 and IPv6, which
is Bun's default, reports an IPv4 client as `::ffff:203.0.113.7`.

### `route`

| Field | Type | |
| --- | --- | --- |
| `method` | `string` | the method the route answers |
| `path` | `string` | the declared path with prefixes joined: `/api/users/:id`, never `/api/users/42` |
| `controller` | `string`, optional | the controller's name; absent for an object literal or a standalone route |
| `name` | `string`, optional | the field the route was declared as |

Built once per route at startup. It is absent on a `404`, a `405` and an
`OPTIONS` request, which have no route. Label logs and metrics with
`route.path`, not the URL: a label per id creates a new series per user.

### `startedAt`

A monotonic reading in milliseconds, taken before any hook runs.
`performance.now() - ctx.startedAt` is how long the request has taken so
far. For wall-clock time, use `Date.now()`.

## `ctx.out`

| Member | Type | |
| --- | --- | --- |
| `status` | `number \| undefined` | the status of a serialized result; ignored for a `Response` and for errors |
| `headers` | `Headers` | added to every response that leaves |
| `cookies.set` | `(name, value, attributes?) => void` | adds a `set-cookie`, signed when the name is covered; a second `set` of a name replaces the first |
| `cookies.delete` | `(name, { path?, domain? }?) => void` | expires the cookie; `path` and `domain` must match the ones it was set with |

The attributes of `set` are Bun's `CookieInit` without `name` and `value`:
`domain`, `path`, `expires`, `maxAge`, `secure`, `httpOnly`, `sameSite`,
`partitioned`.

`ctx.out.headers` applies to serialized results, a handler's `Response`, a
hook's short-circuit and error responses. `set-cookie` is appended, `vary`
is merged token by token, and every other header overwrites.

On a route with a response map, the handler's `ctx.out` is a
`DeclaredOutgoing<Status>`: `status` accepts only a declared status.

## `ctx.res`

In `beforeResponse`, `ctx.res` is the `Response` about to leave. Return a
new `Response` to replace it. Reading its body consumes it, so read
`ctx.res.clone()` instead.

In `afterResponse`, it is a `SentResponse`: `status`, `statusText`,
`headers`, `ok`, `redirected`, `type` and `url`, with no body. Read what
you need before the first `await`.

## `ctx.error`

Whatever was thrown, typed `unknown`:

| Value | From |
| --- | --- |
| `HttpError` | a hook or handler that threw one; a `404` or `405`; a body that failed to parse or was too large |
| `ValidationError` | a request part failed its schema; `issues` lists the failures |
| `ResponseContractError` | the handler broke its response contract |
| anything else | an unexpected failure, such as a `TypeError` or a driver's error |

## Cookies

```ts
function signedCookie(ctx: BaseCtx, name: string): string | undefined
```

Reads a signed cookie from the request's `cookie` header and checks its
signature, for a hook that runs before `ctx.cookies` exists. Returns the
first value whose signature holds, or `undefined`. Throws when the
application signs no cookies or does not sign `name`. See
[Cookies](/docs/concepts/cookies/#reading-a-signed-cookie-early).

## Types

| Type | |
| --- | --- |
| `BaseCtx` | the fields every slot has: `req`, `server`, `out`, `route?`, `startedAt` |
| `Requires<T>` | `BaseCtx & T`, what a reusable hook declares |
| `EarlyCtx<Path>` | `BaseCtx` with raw `params` and `route`, as in `beforeParse` |
| `ValidatedCtx<Path, S>` | the context after validation, from the path and the schemas |
| `HandlerCtx`, `ResponseCtx`, `ErrorCtx` | the context of a handler, a response-slot hook, an `onError` hook |
| `Outgoing`, `DeclaredOutgoing<Status>` | `ctx.out` |
| `DeclaredStatus<S>` | the statuses a response map declares |
| `ResponseCookies`, `CookieAttributes` | `ctx.out.cookies` and its attributes |
| `RouteInfo` | `ctx.route` |
| `BodyType`, `ParsedBody<B>`, `FormBody`, `FormValue` | the body before validation |

Every other type export is listed in
[createApp](/docs/reference/create-app/#types).
