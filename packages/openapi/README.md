# @tetsujs/openapi

An OpenAPI 3.1 document and a docs page, generated from the routes you
already declared.

```bash
bun add @tetsujs/openapi
```

## Usage

Mount the `docs()` controller next to your own:

```ts
import { docs } from "@tetsujs/openapi";

createApp({
  routes: [
    group("/api", { children: [new UsersController(users)] }),
    docs({ info: { title: "Users API", version: "1.0.0" } }),
  ],
});
```

`/openapi.json` serves the document and `/docs` renders it. The document
is built once, at startup, so anything that cannot be described is
reported before the first request.

`docs()` is an ordinary controller: put it in a group to move it under a
prefix, guard it with hooks, or leave it out in production. Its own two
routes are left out of the document.

## Options

| Option | Default | |
| --- | --- | --- |
| `info` | — | the document's `info`: title, version, description |
| `servers` | — | where the API is reachable |
| `path` | `/openapi.json` | where the document is served |
| `uiPath` | `/docs` | where the page is served |
| `ui` | `"scalar"` | `"scalar"`, `"swagger-ui"` or `"redoc"` |
| `title` | the document's title | the page's title |
| `assets` | the renderer's CDN | pinned or self-hosted renderer URLs |
| `documentSelf` | `false` | include `/openapi.json` and `/docs` in the document |
| `onWarning` | `console.warn` | receives what could not be described |

## What goes into the document

| From the route | Becomes |
| --- | --- |
| `path` | the path: `/users/:id` → `/users/{id}` |
| `schema.params`, `query`, `headers`, `cookies` | parameters, required as the schema says |
| `schema.body` and `bodyType` | the request body and its media types |
| `schema.response` | responses — one, or one per status of a map; `null` is a status without a body |
| `docs` | `summary`, `description`, `tags`, `deprecated` |
| the controller and field | `operationId`: `setAvatar` on `UsersController` → `usersSetAvatar` |

`docs: { hidden: true }` leaves a route out of the document; it is served
as before.

```ts
route({
  method: "POST",
  path: "/internal/drain",
  docs: { summary: "Drain the queue", hidden: true },
  handler: () => queue.drain(),
});
```

Schemas are described through Standard Schema's JSON Schema support: Zod,
Valibot, ArkType and [`@tetsujs/typebox`](../typebox) provide it.

## Responses the framework adds

Failures the framework answers by itself are documented on every route
where they can happen, in the same error envelope the server sends:

| Status | `error` | When |
| --- | --- | --- |
| `422` (or the configured validation status) | `VALIDATION_FAILED` | a request part failed its schema |
| `400` | `MALFORMED_JSON` / `MALFORMED_FORM` | the body could not be parsed |
| `413` | `BODY_TOO_LARGE` | the body exceeded `maxBodySize` |
| `500` | `INTERNAL_SERVER_ERROR` | any unhandled failure |

The `error` code is a constant in each schema, so a generated client can
tell failures apart by it. A status the route declares itself is kept, and
the framework's failures for the same status are listed next to it.

## Documenting hooks

A hook that answers by itself — an auth check, a limiter — can say so, and
every route it guards is documented accordingly. `secured()` adds a
security scheme, `documented()` adds responses:

```ts
import { documented, secured } from "@tetsujs/openapi";

export const auth = secured(
  hook.beforeParse((ctx) => {
    const user = verify(ctx.req.headers.get("authorization"));

    if (!user) throw new HttpError(401);

    return { user };
  }),
  { name: "bearerAuth", scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
);

export const guard = documented(hook.beforeParse(check), {
  responses: [{ status: 429, description: "Rate limit exceeded", error: "RATE_LIMITED" }],
});
```

Hooks from `@tetsujs/rate-limit` are already documented this way. A scheme
is identified by its `name`: the same one mounted twice is one
requirement, and two different schemes under one name are reported.

## Using the document directly

When the document itself is the output — written to a file in CI, fed to a
client generator — call the generator:

```ts
import { openapi } from "@tetsujs/openapi";

const { document, warnings } = openapi(app, {
  info: { title: "Users API", version: "1.0.0" },
});

await Bun.write("openapi.json", JSON.stringify(document, null, 2));
```

`docsPage()` renders the page on its own, for serving it elsewhere.

## Warnings

A route is still documented when part of it cannot be described, and the
gap is reported instead of failing the startup:

```
[openapi] POST /api/users: the body schema does not emit JSON Schema
```

This happens with a validator that does not emit JSON Schema, a schema
whose conversion throws, and two routes that map to the same OpenAPI path
(`/files/*` and `/files/:wildcard` are both `/files/{wildcard}`).
