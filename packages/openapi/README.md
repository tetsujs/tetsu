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
    group("/api", { children: [usersController({ users })] }),
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
| the controller's name and the field | `operationId`: `setAvatar` in `controller("Users", …)` → `usersSetAvatar` |

`docs: { hidden: true }` leaves a route out of the document; it is served
as before.

## Operation ids

A generated client names its methods after the `operationId`s, so they are
a contract, and every one comes from a name you wrote:

| Route | `operationId` |
| --- | --- |
| with `docs: { operationId }` | as written |
| in `controller("Users", …)` as `setAvatar` | `usersSetAvatar` |
| in a class `UsersController` as `setAvatar` | `usersSetAvatar` |
| in an object literal as `setAvatar` | `setAvatar` |
| mounted on its own, `POST /auth/code` | `postAuthCode` |

Two routes arriving at the same id stop the application at startup, naming
both — nothing is renamed behind your back, which would change a method in
someone's SDK the day a route is added. Give one of them
`docs.operationId`, or its controller a name of its own. On a public API,
state the id on every route: it is then visible, and a change to it is a
change a reviewer sees.

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

Every envelope — the framework's, a hook's, or one the route declares
itself — is one definition in `components` per status and code, named
after the code (`ITEM_NOT_FOUND` is `ItemNotFound`), so a generated client
gets one type per failure. A schema is recognized as an envelope when its
`error` is required and a single string. When the route and a hook both
describe one code, the route's definition is kept; if the other one has
different fields, the generator warns. A union the route declares joins
the other failures of its status as one flat `anyOf`.

When every alternative of a status is an envelope, the union carries a
`discriminator` on `error`, with the mapping from each code to its
definition, and a generated client narrows on the code.

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
  responses: [
    {
      status: 429,
      description: "Rate limit exceeded",
      error: "RATE_LIMITED",
      fields: { retryAfter: { type: "integer", minimum: 0 } },
      headers: { "retry-after": { schema: { type: "integer", minimum: 0 } } },
    },
  ],
});
```

A response with an `error` code is the framework's envelope, defined once
in `components` and named after the code. `fields` adds what the hook puts
next to `status`, `message` and `error`, each always present; `headers`,
what it sets on the response. Both are JSON Schema written by hand, typed
keyword by keyword (`JsonSchema`), so a misspelled keyword does not
compile. A hook whose body is not the envelope passes a `schema` instead.

Hooks from `@tetsujs/rate-limit` are already documented this way. A scheme
is identified by its `name`: the same one mounted twice is one
requirement, and two different schemes under one name are reported.

Every hook of a route runs, so every scheme its hooks carry is required
together: a route behind a CSRF check and a captcha is documented as
needing both, one entry of `security` — in OpenAPI, separate entries mean
any one of them will do. Two hooks of one scheme require the scopes of
both.

"Either" lives inside one hook: a hook that accepts a session cookie or a
bearer token says so with `anyOf`, and the document lists every
combination a client may bring:

```ts
export const caller = secured(hook.beforeParse(sessionOrToken), {
  anyOf: [cookieSession, bearerToken],
});

// with a CSRF check on the same route:
// security: [{ session: [], csrf: [] }, { bearer: [], csrf: [] }]
```

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
