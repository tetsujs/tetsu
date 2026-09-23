# Changelog

All packages share one version. Until `1.0`, a minor version may change the
API.

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
