# Changelog

All packages share one version. Until `1.0`, a minor version may change the
API.

## Unreleased

### Added

- `@tetsujs/openapi`: `fields` and `headers` on a response passed to
  `documented()` — what a hook adds to the error envelope, and the headers
  it sets. The envelope stays one definition in `components`, with the
  fields in it. Both take the new `JsonSchema` type, JSON Schema 2020-12
  keyword by keyword: a misspelled keyword or an unknown `type` does not
  compile.
- `@tetsujs/openapi`: a status whose alternatives are all error envelopes
  has a `discriminator` on `error`, mapping each code to its definition,
  so a generated client narrows on the code.
- `@tetsujs/openapi`: `docs({ ui: false })` serves the document without
  a page — for an origin that carries a session, where the page would run
  a CDN's code as the signed-in user. `assets` takes `integrity` hashes
  for a renderer of your own.
- `@tetsujs/rate-limit`: `key` reads what earlier `beforeParse` hooks
  returned, typed with `Requires` — a client address worked out once, for
  the limiter and whatever else needs it. The limiter then demands the
  field where it is mounted, like any hook with `Requires`.
- `@tetsujs/lifecycle`: `onShutdownSignals()` and `shutdown()` take a list
  of servers — one process serving several surfaces. They drain within one
  grace period, only a server still draining is cut, and the closers run
  once, after the last server.
- `@tetsujs/core/testing`: `serve(app, { hostname })`. Bun listens on both
  IPv4 and IPv6 by default and reports an IPv4 client as
  `::ffff:127.0.0.1`; `hostname: "127.0.0.1"` makes a test an IPv4 client,
  for checks that compare against `127.0.0.1`.

### Changed

- `@tetsujs/openapi`: the default renderers are pinned to an exact version
  and carry a Subresource Integrity hash — Scalar 1.72.1, Swagger UI
  5.33.0, Redoc 2.5.4. Scalar used to load whatever version was latest.
- `@tetsujs/openapi`: every error envelope is one definition in
  `components` per status and code, named after the code — a route's own
  included, which used to be inlined next to a named twin from a hook or
  the framework. The route's definition is the one kept; a definition
  with different fields is reported as a warning.

### Fixed

- `@tetsujs/openapi`: the page of `docs()` mounted in a group fetched the
  document from the path as configured, without the group's prefix, and
  showed nothing.
- `@tetsujs/openapi`: a status and code declared by both the route and a
  hook was listed twice under the status, and a union the route declared
  was nested inside the status's `anyOf` instead of joining it.
- `@tetsujs/openapi`: a status the route declared and a hook or the
  framework described was documented as `"Response 403; <their
  description>"`. The placeholder is left out when something else
  describes the status, and a status only the route declares is named by
  its reason phrase — `"Not Found"`, not `"Response 404"`.
- `@tetsujs/rate-limit`: the documented `429` now has the `retryAfter`
  field and the `retry-after` header the refusal carries; the document
  described the bare envelope.

## 0.4.1 — 2026-09-25

### Added

- `@tetsujs/openapi`: `secured(hook, { anyOf: [a, b] })` for a hook that
  accepts any one of several credentials — a session cookie or a bearer
  token. The document lists every combination a client may bring, each
  alternative together with the schemes of the route's other hooks.
- `mutualTLS` among the security scheme types, as OpenAPI 3.1 has it.

### Fixed

- `@tetsujs/openapi`: a route guarded by several `secured()` hooks was
  documented as needing any one of their schemes — one `security` entry
  per hook, which OpenAPI reads as alternatives. Every hook runs, so every
  scheme is required: they are one entry now. Two hooks of one scheme with
  different scopes kept only the first one's scopes; they require both.

## 0.4.0 — 2026-09-24

Controllers are declared with `controller()`: a name, and a function from
the controller's dependencies to its routes. Everything a route declares —
hooks, schemas, a body limit — can now come from those dependencies, which
a class could not give its fields.

### Breaking changes

- `accessLog()` moved from `@tetsujs/request-id` to the new
  `@tetsujs/request-log`, with `AccessRecord`, `AccessLogOptions` and
  `AccessLogHook`. `@tetsujs/request-id` is `requestId()` alone.
- `ctx.route.controller`, and `controller` on `app.entries`, are optional:
  an object literal and a route mounted on its own have no name, where
  they were `"Object"` and `"(standalone)"`.
- Two controllers of one application with the same name are refused at
  startup — one class mounted twice, or one factory called twice,
  included. Two versions of an API are two names over one body.
- `@tetsujs/openapi`: two routes arriving at one `operationId` stop the
  application, naming both. Before, the second one was renamed after its
  method and path, or numbered — a method of a generated SDK changing
  without anyone seeing it. A route of an unnamed object is named by its
  field now, not `object<Field>`.

### Added

- `@tetsujs/request-log`, the request logs: `accessLog()`, and
  `arrivalLog()` — a `beforeParse` hook that writes a line when a request
  arrives, for the request that hangs or dies before `accessLog()` would
  see it. Its record is `{ method, path, requestId? }`, under the same
  rules as the access record: the pathname, no query, headers or body.
- `controller(name, build)`, the form of a controller the README shows.
  The name is what every `operationId` is built from, apart from the
  variable that holds the factory, so renaming code changes no client.
- `docs.operationId` on a route, for an id stated rather than derived.

### Fixed

- A `hooks` object the compiler would refuse is refused at startup too,
  for code the compiler did not check — `as never`, plain JavaScript,
  loose types. A slot element that is not a hook used to answer every
  request with a `500`; a hook under another slot ran at the wrong moment;
  a misspelled slot, `beforParse`, was never read, and the hook in it never
  ran. Each now stops `createApp`, naming the level, the slot and the
  position.

### Moving from 0.3

```ts
// 0.3
class OrdersController {
  constructor(private orders: OrderService) {}

  list = route({ method: "GET", path: "/orders", handler: () => this.orders.all() });
}

createApp({ routes: new OrdersController(orders) });

// 0.4
const ordersController = controller("Orders", ({ orders }: { orders: OrderService }) => ({
  list: route({ method: "GET", path: "/orders", handler: () => orders.all() }),
}));

createApp({ routes: ordersController({ orders }) });
```

A class keeps working and is named after itself, `operationId`s included;
`controller("Orders", …)` gives the same `ordersList` as `OrdersController`.

`accessLog` is imported from its new package:

```ts
// 0.3
import { accessLog, requestId } from "@tetsujs/request-id";

// 0.4
import { requestId } from "@tetsujs/request-id";
import { accessLog } from "@tetsujs/request-log";
```

## 0.3.0 — 2026-09-24

Hooks are mounted one way everywhere: an object keyed by slot, each slot a
list of hooks, so everything that runs for a request is written out where
it is mounted. This changes how hook packages are mounted.

- **Breaking.** `hooks` on `createApp` and `group` is one object keyed by
  slot, as on a route. The list of hook sets is gone; a list is refused at
  compile time and at startup with the form to write instead.
- **Breaking.** Every hook package returns one hook: `cors()` and
  `requestId()` and `rateLimit()` for `beforeParse`, `secureHeaders()` for
  `beforeResponse`, `accessLog()` for `afterResponse`. Their types are
  singular now: `CorsHook`, `RequestIdHook`, `AccessLogHook`,
  `RateLimitHook`, `SecureHeadersHook`.
- **Breaking.** `stack()` is removed. Write the hooks in the slot, or
  declare a shared array `as const`.
- `ctx.startedAt`: the monotonic time the core took the request, before any
  hook ran. `AccessRecord.durationMs` is measured from it and always present.
- One hook instance mounted twice in a route's chain — on a group and on a
  route under it, or twice in one slot — is refused at startup.
- A `hooks` object typed with an index signature — `Record<string, …>`, or
  what `Object.fromEntries` returns — is refused. Before, none of its slots
  was checked, on routes too.
- `@tetsujs/request-id`: the pino recipe in the README returned the stored
  object from `mixin`, which pino mutates, so one log line's fields leaked
  into every later line of the request. It returns a copy now:
  `mixin: () => ({ ...current() })`.

### Moving from 0.2

```ts
// 0.2
createApp({
  hooks: [cors(origins), requestId(), accessLog(), secureHeaders(), { beforeParse: [mine] }],
  routes,
});

// 0.3: each hook made once, and mounted in its slot
const browser = cors(origins);
const id = requestId();
const log = accessLog();
const secure = secureHeaders();

createApp({
  hooks: {
    beforeParse: [browser, id, mine],
    beforeResponse: [secure],
    afterResponse: [log],
  },
  routes,
});
```

On a route, `hooks: { beforeParse: [...limit.beforeParse] }` becomes
`hooks: { beforeParse: [limit] }`. Mount `cors()` first in `beforeParse`:
a hook before it that refuses answers without the CORS headers.

## 0.2.0 — 2026-09-24

- `createApp({ reportError })` receives the failures no response can
  carry: an error no `onError` hook answered, a broken response contract,
  a failing `afterResponse` hook, a WebSocket handler, a stream. A report
  has a `source`, the `error` itself and the request's `ctx`, typed from
  the application's hooks. Without it they are printed as before.
- `reportFailure(ctx, source, error)` lets a package report the same way.
  `@tetsujs/sse` reports stream failures through it, printed as
  `[tetsu] stream failed:` without a receiver.
- A handler that breaks its response contract throws
  `ResponseContractError`, reported once, with the schema's `issues` in a
  field of their own; it used to print two lines.
- `@tetsujs/lifecycle`: `onShutdownSignals` takes `reportError` for the
  closers that threw.
- A hook of a group or of the application sees what the hooks before it
  at the same level contributed. `[requestId(), { beforeParse: [scope] }]`
  compiles, so the `AsyncLocalStorage` recipe in `@tetsujs/request-id`
  works on the application, where it covers every request. Before, such a
  hook could require only the slot's base context.

## 0.1.0 — 2026-09-24

First release.

- `@tetsujs/core` — controllers and routes, lifecycle hooks, validation
  through Standard Schema, typed responses and errors, signed cookies,
  WebSocket endpoints, and testing helpers in `@tetsujs/core/testing`.
- `@tetsujs/cors`, `@tetsujs/rate-limit`, `@tetsujs/request-id`,
  `@tetsujs/secure-headers` — hook packages for the application.
- `@tetsujs/openapi` — an OpenAPI 3.1 document and docs page from the
  routes.
- `@tetsujs/typebox` — TypeBox schemas as DTOs.
- `@tetsujs/sse` — server-sent events and streamed responses.
- `@tetsujs/lifecycle` — graceful shutdown.

Requires Bun 1.4 or later and TypeScript 5.7 or later.
