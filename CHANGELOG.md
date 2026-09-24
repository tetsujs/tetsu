# Changelog

All packages share one version. Until `1.0`, a minor version may change the
API.

## Unreleased

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
