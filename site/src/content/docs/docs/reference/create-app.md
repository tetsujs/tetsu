---
title: createApp
description: The options of createApp, what the returned application carries, what is refused at startup, and every export of @tetsujs/core.
sidebar:
  order: 1
---

`createApp()` compiles the routes, groups and hooks into a route table and
returns an application in the shape `Bun.serve` takes.

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
  reportError: ({ source, error }) => console.error(source, error),
});

Bun.serve({ ...app, port: 3000 });
```

## Options

| Option | Type | Default | |
| --- | --- | --- | --- |
| `routes` | `object \| readonly object[]` | required | a controller, a group, a route, a `ws()` endpoint, or an array of them |
| `hooks` | hooks keyed by slot | none | application hooks, run for every request |
| `cookies` | `CookieOptions` | none | the secret and the names of signed cookies |
| `maxBodySize` | `number` | `1048576` (1 MiB) | the largest request body, in bytes |
| `validateResponses` | `boolean` | `true` | check results against `schema.response` |
| `validation` | `{ status?: 400 \| 422 }` | `{ status: 422 }` | the status of a validation failure |
| `fallback` | `(ctx: BaseCtx) => unknown` | the `404` envelope | answers a path no route matches |
| `reportError` | `(report: FailureReport) => unknown` | print to `console.error` | receives failures no response can carry |

### `routes`

Arrays nest, and a controller is read by its own string-keyed fields. See
[Groups and mounting](/docs/concepts/groups-and-mounting/).

### `hooks`

An object keyed by slot: `{ beforeParse: [a, b], afterResponse: [c] }`.
Application hooks run before group and route hooks in every slot, except
`onError`, where they run last. They are the only hooks that run for a
`404`, a `405` and an `OPTIONS` request. See
[Hook slots](/docs/reference/hooks/).

### `cookies`

| Field | Type | Default | |
| --- | --- | --- | --- |
| `secret` | `string` | required | the HMAC-SHA256 key, 32 random bytes or more |
| `sign` | `true \| string \| readonly string[]` | `true` | the names to sign; `true` signs every cookie |

An empty or missing `secret` throws a `TypeError` at startup. See
[Cookies](/docs/concepts/cookies/#signed-cookies).

### `maxBodySize`

A `content-length` above the limit is a `413` before any byte is read. A
body without one is cut at the chunk that crosses the limit, and a
`"stream"` body errors with the same `413`. A route's own `maxBodySize`
overrides this one. A handler that reads `ctx.req` itself is not capped.

### `validateResponses`

When `true`, a serialized result is checked against the schema of its
status. A status the response map does not declare, a body under a
bodiless status, a value or nothing under a status whose `contentType` is
not JSON, and response `headers` or `cookies` that fail their schema are
refused too. Each failure is a `500` and a report with
`source: "response"`. A `Response` built by the handler is never checked.

`false` turns every response check off. The framework never reads
`NODE_ENV`: to check outside production only, pass
`Bun.env.NODE_ENV !== "production"`.

### `validation`

`422` by default. Set `400` if your API uses `400` for every broken
contract. A malformed JSON or form body is a `400` either way.

### `fallback`

Replaces the `404` for unmatched paths, and runs with the application's
hooks. Its result is serialized like a handler's: `200`, or `204` for
`undefined`, unless it sets `ctx.out.status` or returns a `Response`. An
SPA index wants the `200`; a custom `404` must set its status.

### `reportError`

Receives `{ source, error, ctx }` for each failure no response can carry:
an error no `onError` hook answered, a broken response contract, a failing
`onError` or `afterResponse` hook, a WebSocket handler, a stream, a
shutdown step. `ctx` is typed from the application's own hooks, each
field optional, and is absent when there was no request. It is called in
place and never awaited. See
[Errors](/docs/concepts/errors/#failures-that-cannot-become-a-response).

## The application

| Field | Type | |
| --- | --- | --- |
| `routes` | `Record<string, PathHandler>` | one native Bun route per declared path |
| `fetch` | `(req, server) => Promise<Response>` | the no-match handler: the `404` or the `fallback` |
| `websocket` | `WebSocketHandler<SocketState>` | the handler for every socket; always present |
| `maxRequestBodySize` | `number`, optional | Bun's own body cap, raised above the largest `maxBodySize`; set only when that exceeds Bun's default of 128 MiB |
| `entries` | `readonly RouteTableEntry[]` | the compiled route table, for tooling |
| `options` | `AppOptions` | the options in force: `validationStatus`, `validateResponses`, `maxBodySize`, and `cookieSealer` when `cookies` is set |
| `printRoutes` | `() => void` | prints each route's method, full path and controller |

`Bun.serve({ ...app })` takes `routes`, `fetch`, `websocket` and
`maxRequestBodySize` and ignores the rest. Bun's own options go after the
spread:

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

`app.fetch` does not route: Bun's router does, and `fetch` runs only when
no path matched. Calling it directly always takes the fallback, so tests
go through a real server with `serve()` from `@tetsujs/core/testing`.

Each path answers `HEAD` from its `GET` route, `OPTIONS` with `204` and an
`Allow` header, and any other undeclared method with `405` and the same
`Allow`.

`app.entries[n]` has `method`, `path` (prefixes joined), `def`, `hooks`
(the merged chains), `route` (what `ctx.route` is), and `controller`,
`name` and `ws` when they apply.

`AppRoutes<typeof app>` is the type of every HTTP route, keyed by
`"METHOD /full/path"`, with its schemas. A typed client is built from it.
Socket endpoints are not in it.

## Checked at startup

`createApp` throws when:

- two routes have the same method and full path;
- two paths differ only in parameter names (`/users/:id`, `/users/:userId`);
- two controllers share a name;
- the same hook instance is mounted twice in one route's chain;
- a class is mounted instead of an instance, or an application as a child;
- a controller declares a route under a symbol key or as a class getter;
- `hooks` is a list, a key is not a slot, a slot is not a list, an element
  is not a hook, or a hook sits in a slot other than its own;
- `cookies.secret` is empty or missing.

A controller without routes is a warning on `console.warn`.

Once the table is built, each mounted controller with an `[onMount](app)`
method receives the application, once, before `createApp` returns.

## Exports

| Export | Kind | Reference |
| --- | --- | --- |
| `createApp` | function | this page |
| `route` | function | [route](/docs/reference/route/#route) |
| `controller` | function | [route](/docs/reference/route/#controller) |
| `group` | function | [route](/docs/reference/route/#group) |
| `ws` | function | [route](/docs/reference/route/#ws) |
| `hook` | object of factories | [Hook slots](/docs/reference/hooks/#factories) |
| `onMount` | symbol | the key of a controller method `[onMount](app)`, called with the built application |
| `isRoute`, `isGroup`, `isWs` | functions | type guards for a `RouteDef`, a `GroupNode`, a `WsDef` |
| `HttpError`, `httpError`, `errorBody`, `ValidationError` | classes and functions | [Framework error codes](/docs/reference/error-codes/#throwing) |
| `ResponseContractError`, `reportFailure` | class, function | [Framework error codes](/docs/reference/error-codes/#reported-failures) |
| `signedCookie` | function | [Context fields](/docs/reference/context/#cookies) |
| `toJsonSchema` | function | `toJsonSchema(schema, { target }, direction?)`: a schema's JSON Schema, or `undefined` when the validator cannot produce one |

`@tetsujs/core/testing` exports `testCtx(parts, { cookies })`,
`serve(app, { hostname, stop })`, `stopServers()` and `captureErrors()`. See
[Testing](/docs/guides/testing/).

### Types

| Area | Types | Reference |
| --- | --- | --- |
| Application | `AppConfig`, `App`, `AppOptions`, `AppContext`, `AppRoutes`, `FallbackHandler`, `PathHandler`, `RoutedRequest` | this page |
| Route table | `RouteMap`, `RouteSignature`, `RoutesOf`, `RouteTableEntry`, `Mountable` | this page |
| Routes | `RouteConfig`, `RouteDef`, `RouteDocs`, `Method`, `SchemaConfig`, `ResponseEntry`, `HandlerResult`, `HandlerMustReturn`, `HandlerReturnMarker`, `ValidateResult`, `ResultError` | [route](/docs/reference/route/) |
| Paths | `ExtractParams`, `ValidatePath`, `ValidatePrefix`, `PathError` | [route](/docs/reference/route/#path) |
| Groups | `GroupNode`, `GroupOptions`, `GroupConfig`, `GroupHooks` | [route](/docs/reference/route/#group) |
| WebSockets | `WsConfig`, `WsDef`, `WsSchemaConfig`, `Socket`, `SocketData`, `SocketState`, `MessageOf` | [route](/docs/reference/route/#ws) |
| Hooks | `Hook`, `AnyHook`, `SlotName`, `SlotBases`, `SentResponse`, `HooksConfig`, `MergedHooks`, `HookSlotError`, `HookRequirementError`, `HookStackError` | [Hook slots](/docs/reference/hooks/) |
| Context | `BaseCtx`, `EarlyCtx`, `ValidatedCtx`, `HandlerCtx`, `ResponseCtx`, `ErrorCtx`, `Requires`, `RouteInfo`, `Outgoing`, `DeclaredOutgoing`, `DeclaredStatus`, `BodyType`, `ParsedBody`, `FormBody`, `FormValue` | [Context fields](/docs/reference/context/#types) |
| Cookies | `CookieOptions`, `CookieAttributes`, `ResponseCookies` | [`cookies`](#cookies) above, [Context fields](/docs/reference/context/#ctxout) |
| Errors | `ErrorBody`, `ValidationIssue`, `FailureReport`, `FailureSource`, `ReportError` | [Framework error codes](/docs/reference/error-codes/) |
| Schemas | `AnySchema`, `InferInput`, `InferOutput`, `JsonSchemaDirection`, `Standard*` | the [Standard Schema](https://standardschema.dev) interfaces |
