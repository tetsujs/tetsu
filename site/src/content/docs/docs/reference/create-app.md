---
title: createApp
description: Every option of createApp, its type and default, what the returned application carries, what is refused at startup, and every runtime export of @tetsujs/core.
sidebar:
  order: 1
---

`createApp()` compiles the routes, groups and hooks into a route table and
returns an application in the shape `Bun.serve` takes.

```ts
function createApp(config: AppConfig): App
```

```ts twoslash
import { createApp, hook } from "@tetsujs/core";
declare const routes: object[];
declare const log: ReturnType<typeof hook.afterResponse>;
// ---cut---
const app = createApp({
  routes,
  hooks: { afterResponse: [log] },
  cookies: { secret: Bun.env.COOKIE_SECRET!, sign: ["session"] },
  maxBodySize: 2 * 1024 * 1024,
  validateResponses: true,
  validation: { status: 422 },
  reportError: ({ source, error }) => console.error(source, error),
});

Bun.serve({ ...app, port: 3000 });
```

## Options

| Option | Type | Default | |
| --- | --- | --- | --- |
| `routes` | `object \| readonly object[]` | required | the topology: a controller, a group, a route, or an array of them |
| `hooks` | hooks keyed by slot | none | application hooks, run for every request, including `404`, `405` and `OPTIONS` |
| `cookies` | `CookieOptions` | none | the secret and the names of signed cookies |
| `maxBodySize` | `number` | `1048576` (1 MiB) | largest request body, in bytes, for a route that reads one |
| `validateResponses` | `boolean` | `true` | check results against `schema.response`; `false` turns every response check off |
| `validation` | `{ status?: 400 \| 422 }` | `{ status: 422 }` | the status of a validation failure |
| `fallback` | `(ctx: BaseCtx) => unknown` | the `404` envelope | answers a path no route matches |
| `reportError` | `(report: FailureReport) => unknown` | printed to `console.error` | receives failures no response can carry |

### `routes`

Anything `createApp` finds is mounted: a controller's route fields, a
group's children, a `RouteDef` on its own, a `ws()` endpoint, and arrays of
any of these, nested. A controller is read by its own string-keyed fields.
See [Groups and mounting](/docs/concepts/groups-and-mounting/).

### `hooks`

An object keyed by slot: `{ beforeParse: [a, b], afterResponse: [c] }`.
Application hooks run before a group's and a route's in every slot, except
`onError`, where they run last. They are the only hooks that run for an
unmatched path, an unmatched method and a preflight. A hook may require
what its slot guarantees and what the application's earlier hooks
contribute. See [Hook slots](/docs/reference/hooks/).

### `cookies`

| Field | Type | Default | |
| --- | --- | --- | --- |
| `secret` | `string` | required | the HMAC-SHA256 key, 32 random bytes or more |
| `sign` | `true \| string \| readonly string[]` | `true` | the names signed; `true` is every cookie |

An empty or non-string `secret` throws a `TypeError` at startup. See
[Cookies](/docs/concepts/cookies/#signed-cookies).

### `maxBodySize`

Counted while the body is read: a `content-length` above it is a `413`
before a byte is read, a chunked body is cut at the chunk that crosses it,
and a `"stream"` body errors with the same `413` when it does. A route's
own `maxBodySize` overrides it. A handler that reads `ctx.req` itself is
not capped by it.

### `validateResponses`

With `true`, a serialized result is checked against the schema of its
status, a status the response map does not declare is refused, a value
under a bodiless status is refused, and a response entry's `headers` and
`cookies` are checked. Each failure is a `500` and a report with
`source: "response"`. A `Response` the handler builds is never checked. The
framework never reads `NODE_ENV`.

### `validation`

`422` by default; `400` for the convention that a `400` means the contract
was broken. A malformed JSON or form body is `400` either way.

### `fallback`

Replaces the `404` for unmatched paths. It runs with the application's
hooks, and its result is serialized like a handler's: `200`, or `204` for
`undefined`, unless it sets `ctx.out.status` or returns a `Response`. An
SPA index wants that; a custom `404` states its status.

### `reportError`

Receives `{ source, error, ctx }` for an error no `onError` hook answered,
a broken response contract, a failing `onError` or `afterResponse` hook, a
WebSocket handler, a stream, a shutdown step. `ctx` is typed from the
application's own hooks, each field optional, and absent where there was
no request. It is called in place and never awaited; a receiver that
throws is printed with the report. See
[Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response).

## The application

| Field | Type | |
| --- | --- | --- |
| `routes` | `Record<string, PathHandler>` | one native Bun route per declared path |
| `fetch` | `(req, server) => Promise<Response>` | the no-match handler: the `404` or the `fallback` |
| `websocket` | `WebSocketHandler<SocketState>` | the handler for every socket; always present |
| `maxRequestBodySize` | `number`, optional | Bun's body cap, raised above the largest `maxBodySize`; present only when that exceeds Bun's default of 128 MiB |
| `entries` | `readonly RouteTableEntry[]` | the compiled route table, for tooling |
| `options` | `AppOptions` | the options in force, defaults filled in |
| `printRoutes` | `() => void` | prints each route's method, full path and controller |

`Bun.serve({ ...app })` takes `routes`, `fetch`, `websocket` and
`maxRequestBodySize` from the spread; the others are ignored by Bun. A
value placed after the spread wins, which is how Bun's own options are
changed:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({ routes });

Bun.serve({
  ...app,
  port: 3000,
  idleTimeout: 30,
  websocket: { ...app.websocket, idleTimeout: 60 },
});
```

`app.fetch` does not route: Bun's router does, and `fetch` is reached only
when no path matched. Calling it directly always takes the fallback. Tests
go through a real server — `serve()` from `@tetsujs/core/testing`.

Each path answers `HEAD` from its `GET` route, `OPTIONS` with `204` and an
`Allow` header, and any other undeclared method with `405` and the same
`Allow`.

`app.options` holds `validationStatus`, `validateResponses`,
`maxBodySize`, and the cookie signer when `cookies` is set.
`app.entries[n]` has `method`, `path` (prefixes joined), `def`, `hooks` (the
merged chains), `route` (what `ctx.route` is), and `controller`, `name` and
`ws` when they apply.

The routes are also carried in the type: `AppRoutes<typeof app>` is the map
of every HTTP route, keyed by `"METHOD /full/path"`, with its schemas —
what a typed client is built from. Socket endpoints are not in it.

## Checked at startup

`createApp` throws, rather than serve a table that would misbehave, when:

- two routes have the same method and full path;
- two paths differ only in parameter names (`/users/:id`, `/users/:userId`);
- two controllers share a name;
- the same hook instance is mounted twice in one route's chain;
- a class is mounted instead of an instance, or an application as a child;
- a controller declares a route under a symbol key or as a getter;
- a `hooks` key is not a slot, a slot is not a list, an element is not a
  hook, or a hook sits in a slot other than its own;
- `hooks` is a list rather than an object keyed by slot;
- `cookies.secret` is empty or missing.

A controller without routes is a warning on `console.warn`. After the table
is built, every mounted controller that declares an
[`onMount`](#every-runtime-export) method receives the application, once,
before `createApp` returns.

## Every runtime export

| Export | Kind | Reference |
| --- | --- | --- |
| `createApp` | function | this page |
| `route` | function | [route](/docs/reference/route/#route) |
| `controller` | function | [route](/docs/reference/route/#controller) |
| `group` | function | [route](/docs/reference/route/#group) |
| `ws` | function | [route](/docs/reference/route/#ws) |
| `hook` | object of factories | [Hook slots](/docs/reference/hooks/#factories) |
| `onMount` | symbol | a controller method `[onMount](app)` called with the built application |
| `isRoute`, `isGroup`, `isWs` | functions | type guards for a `RouteDef`, a `GroupNode`, a `WsDef` |
| `HttpError` | class | [Framework error codes](/docs/reference/error-codes/#throwing) |
| `httpError` | function | [Framework error codes](/docs/reference/error-codes/#throwing) |
| `errorBody` | function | [Framework error codes](/docs/reference/error-codes/#throwing) |
| `ValidationError` | class | [Framework error codes](/docs/reference/error-codes/#throwing) |
| `ResponseContractError` | class | [Framework error codes](/docs/reference/error-codes/#reported-failures) |
| `reportFailure` | function | [Framework error codes](/docs/reference/error-codes/#reported-failures) |
| `signedCookie` | function | [Context fields](/docs/reference/context/#cookies) |
| `toJsonSchema` | function | `toJsonSchema(schema, { target }, direction?)` — a schema's JSON Schema through Standard Schema, or `undefined` |

`@tetsujs/core/testing` exports `testCtx(parts, { cookies })`,
`serve(app, { hostname })`, `stopServers()` and `captureErrors()` — see
[Testing](/docs/guides/testing/).

The type exports are listed with what they describe: `AppConfig`, `App`,
`AppOptions`, `AppContext`, `AppRoutes`, `FallbackHandler`, `PathHandler`
and `RoutedRequest` here; `RouteConfig`, `RouteDef`, `RouteDocs`, `Method`,
`WsConfig`, `WsDef` and `GroupConfig` in [route](/docs/reference/route/);
`Hook`, `AnyHook`, `SlotName`, `SlotBases`, `SentResponse` and `Requires`
in [Hook slots](/docs/reference/hooks/); `BaseCtx`, `Outgoing`,
`RouteInfo` and the rest of the context in
[Context fields](/docs/reference/context/).
