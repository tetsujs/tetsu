# Changelog

All packages share one version. Until `1.0`, a minor version may change the
API.

## Unreleased

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
