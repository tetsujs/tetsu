---
title: "@tetsujs/openapi"
description: An OpenAPI 3.1 document and a docs page, generated from the routes you already declared.
sidebar:
  order: 2
  label: "@tetsujs/openapi"
---

`@tetsujs/openapi` reads an application's routes and produces an OpenAPI 3.1
document and a page that renders it. Paths, parameters, bodies and responses
come from the schemas and response maps the routes already have, so nothing
is written twice. To turn the document into a typed client, see
[Typed client from OpenAPI](/docs/guides/typed-client/).

```bash
bun add @tetsujs/openapi
```

## Usage

Mount the `docs()` controller next to your own:

```ts twoslash
import { controller, createApp, group, route } from "@tetsujs/core";

const usersController = controller("Users", () => ({
  list: route({ method: "GET", path: "/users", handler: () => [] }),
}));
// ---cut---
import { docs } from "@tetsujs/openapi";

createApp({
  routes: [
    group("/api", { children: [usersController()] }),
    docs({ info: { title: "Users API", version: "1.0.0" } }),
  ],
});
```

`/openapi.json` serves the document and `/docs` renders it. The document
covers the whole application `docs()` is mounted in, except its own two
routes. It is built once, at startup, so anything that cannot be described
is reported before the first request.

`docs()` is an ordinary controller: put it in a group to move it under a
prefix, guard it with hooks, or leave it out in production. A group does not
narrow the document, so two documents, such as a public API and an admin
one, need two applications, each with its own `docs()`.

A route adds what the schemas cannot say in `docs`:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
const list = route({
  method: "GET",
  path: "/users",
  docs: { summary: "List users", tags: ["users"], operationId: "listUsers" },
  handler: () => [],
});
```

`docs` also takes `description`, `deprecated`, and `hidden: true`, which
leaves the route out of the document while it is still served.
`hidden: false` keeps a route in when its handler would hide it, see
[Documenting a handler](#documenting-a-handler). WebSocket endpoints are
never in the document: OpenAPI cannot describe what happens after the
handshake.

## Options

| Option | Default | |
| --- | --- | --- |
| `info` | required | the document's `info`: title, version, description |
| `servers` | none | where the API is reachable |
| `path` | `/openapi.json` | where the document is served |
| `uiPath` | `/docs` | where the page is served |
| `ui` | `"scalar"` | `"scalar"`, `"swagger-ui"`, `"redoc"`, or `false` for no page |
| `title` | the document's title | the page's title |
| `assets` | the renderer on jsDelivr, pinned | your own renderer URLs, with `integrity` hashes, see [The page and your origin](#the-page-and-your-origin) |
| `documentSelf` | `false` | include the two docs routes in the document, under the tag `docs` |
| `onWarning` | `console.warn` | receives what could not be described, see [Warnings](#warnings) |
| `errors` | the framework's envelope | an error format of your own, see [below](#an-error-format-of-your-own) |
| `tags` | none | a description for each tag, in sidebar order, see [Tags](#tags) |

`path` and `uiPath` go under the prefix of any group `docs()` is mounted in,
and the page finds the document there.

## How a route becomes an operation

| In the document | Comes from |
| --- | --- |
| the path | the route's `path` under its groups' prefixes: `/users/:id` becomes `/users/{id}` |
| `operationId` | `docs.operationId`, or the controller and field name, see [Operation ids](#operation-ids) |
| `summary`, `description`, `tags`, `deprecated` | the route's `docs` |
| parameters | `schema.params`, `query`, `headers` and `cookies`, required as the schema says |
| the request body | `schema.body` and `bodyType`; required unless `bodyType` is `text` or `stream` |
| responses | `schema.response`, hooks annotated with [`documented()` and `secured()`](#documenting-hooks), a handler annotated with [`documented()`](#documenting-a-handler), and the [failures the framework adds](#responses-the-framework-adds) |
| `security` | `secured()` hooks on the route, its groups and the application |

Schemas are converted through Standard Schema's JSON Schema support, which
Zod, ArkType and [`@tetsujs/typebox`](/docs/packages/typebox/) provide;
Valibot needs `toStandardJsonSchema` from `@valibot/to-json-schema`.

Responses follow the route's response map (see
[Responses](/docs/concepts/responses/)):

- One schema is a `200`. A map gives its statuses. `null` is a status
  without a body, and so is an entry with neither `body` nor a
  `contentType` of its own.
- A route with no `schema.response` is documented as `200`. If its handler
  can answer `204`, declare `204: null`.
- An entry `{ body, headers, cookies }` documents its headers, required as
  its schema says, and its cookies as one `set-cookie` header.
- An entry with `contentType` documents its body under that media type
  instead of `application/json`, with `body` as its schema, or by the type
  alone without one: a CSV export, a file, `"text/event-stream"` for
  [`sse()`](/docs/packages/sse/#in-the-openapi-document). See
  [Responses](/docs/concepts/responses/#a-body-that-is-not-json). OpenAPI
  3.1 cannot describe the events of a stream one by one, so a stream is
  documented by its type alone.
- When several sources answer with one status, the JSON body is one flat
  `anyOf`, the route's own schema first. A body of another type is listed
  next to it under its own media type.

## Operation ids

A generated client names its methods after the `operationId`s, so every one
comes from a name you wrote:

| Route | `operationId` |
| --- | --- |
| with `docs: { operationId }` | as written |
| in `controller("Users", …)` as `setAvatar` | `usersSetAvatar` |
| in a class `UsersController` as `setAvatar` | `usersSetAvatar` |
| in an object literal as `setAvatar` | `setAvatar` |
| mounted on its own, `POST /auth/code` | `postAuthCode` |

Two routes with the same id are refused when the document is built, naming
both: `docs()` stops the application at startup, and `openapi()` throws.
Nothing is renamed for you, since that would change a method in a generated
client the day a route is added. Give one of them `docs.operationId`, or its
controller another name. On a public API, write the id on every route, so a
change to it shows up in review.

## Tags

A route names its tags in `docs: { tags }`. The `tags` option says what each
one is:

```ts twoslash
import { docs } from "@tetsujs/openapi";

const info = { title: "Users API", version: "1.0.0" };
// ---cut---
const documentation = docs({
  info,
  tags: {
    "sign-in": "Signing in with a code sent by email, and signing out",
    me: "The signed-in user",
  },
});
```

Renderers list the sections in the order of the keys. A tag the routes use
but `tags` leaves out comes after them and is reported as a warning. It is
usually one tag spelled two ways, `sign_in` next to `sign-in`. A tag
described but never used is reported too. Without `tags`, the document lists
none and nothing is reported.

## Responses the framework adds

The framework answers some failures by itself. They are documented on every
route where they can happen, in the envelope the server sends:

| Status | `error` | When |
| --- | --- | --- |
| `422`, or `validation.status` of `createApp` | `VALIDATION_FAILED` | the route has a request schema, and a part failed it |
| `400` | `MALFORMED_JSON` / `MALFORMED_FORM` | the route reads a JSON or form body, and it could not be parsed |
| `413` | `BODY_TOO_LARGE` | the route reads a body, and it exceeded `maxBodySize` |
| `500` | `INTERNAL_SERVER_ERROR` | every route: an unhandled failure |

See [Framework error codes](/docs/reference/error-codes/). A status the route
declares itself is kept, and the framework's failures for that status are
listed next to it.

Every envelope, whether from the framework, a hook or the route, becomes one
definition in `components`, named after its code: `ITEM_NOT_FOUND` becomes
`ItemNotFound`. A generated client gets one type per failure. A schema counts
as an envelope when its `error` is required and a single string. When every
alternative of a status is an envelope, the status gets a `discriminator` on
`error`, so a client can narrow on the code.

A status's description comes from what answers with it: the `description`
of the route's schema (`.describe()` in Zod and ArkType, `v.description()`
in Valibot, `{ description }` in TypeBox), a hook's or a handler's
`documented()` description, or the framework's own. Several descriptions
become a list led by each code:

```md
- `ACCOUNT_DISABLED`: this account is disabled
- `CAPTCHA_FAILED`: the captcha token is missing or did not pass
```

A status with no description keeps its reason phrase, such as `Not Found`.

## Documenting hooks

A hook that answers by itself, such as an auth check or a limiter, can say
so. Every route it guards is then documented with it. `secured()` adds a
security scheme, `documented()` adds responses:

```ts twoslash
import { hook, HttpError } from "@tetsujs/core";

declare function verify(header: string | null): { id: string } | undefined;
declare function check(ctx: object): void;
// ---cut---
import { documented, secured } from "@tetsujs/openapi";

export const auth = secured(
  hook.beforeParse((ctx) => {
    const user = verify(ctx.req.headers.get("authorization"));

    if (!user) throw new HttpError(401);

    return { user };
  }),
  { name: "bearerAuth", scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
);

export const guard = documented(hook.beforeParse((ctx) => check(ctx)), {
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

Both return a copy of the hook with the same type, so it goes into a stack
like any other. A hook mounted on a group or the application documents every
route under it. Hooks from [`@tetsujs/rate-limit`](/docs/packages/rate-limit/)
come documented already.

A response in `documented()` takes:

- `contentType`: the media type of a body that is not JSON, such as
  `"text/html"`, without parameters. `documented()` throws on anything but
  a bare type or a range.
- `error`: the envelope's code, documented as a `const`.
- `fields`: what the hook adds next to `status`, `message` and `error`,
  always present.
- `headers`: what it sets on the response, documented as possible, not
  required.
- `message`: an example of the envelope's message.
- `schema`: the body, for a hook that does not answer with the envelope.

Without `schema` or `contentType`, an error status is the envelope and any
other status, such as a redirect, has no body.

`fields` and `headers` are JSON Schema typed keyword by keyword
(`JsonSchema`), so a misspelled keyword does not compile.

`secured()` takes:

| Field | Default | |
| --- | --- | --- |
| `name` | required | the name the scheme is registered under in `components` |
| `scheme` | required | the OpenAPI security scheme; its `type` is `http`, `apiKey`, `oauth2`, `openIdConnect` or `mutualTLS` |
| `scopes` | none | OAuth2 scopes |
| `status` | `401` | the status a refused request gets |
| `description` | none | how the refusal is described |
| `error` | none | the refusal's `error` code |
| `message` | none | an example of the refusal's message |

Every hook of a route runs, so the schemes of all its hooks are required
together: a route behind a CSRF check and a captcha needs both. To accept
one credential or another, such as a session cookie or a bearer token, check
both in one hook and pass `anyOf`:

```ts twoslash
import { hook } from "@tetsujs/core";
import type { SecurityRequirement } from "@tetsujs/openapi";

declare function sessionOrToken(ctx: object): { id: string };
declare const cookieSession: SecurityRequirement;
declare const bearerToken: SecurityRequirement;
// ---cut---
import { secured } from "@tetsujs/openapi";

export const caller = secured(hook.beforeParse((ctx) => ({ user: sessionOrToken(ctx) })), {
  anyOf: [cookieSession, bearerToken],
});
```

With a CSRF check on the same route, the document says
`security: [{ session: [], csrf: [] }, { bearer: [], csrf: [] }]`.

## Documenting a handler

A handler a package hands out, such as one serving a directory of files,
can describe every route it is mounted on, the way a hook describes the
routes it guards. `documented()` takes the handler and returns a copy that
answers the same way:

```ts twoslash
import type { BaseCtx } from "@tetsujs/core";
declare function readFile(ctx: BaseCtx): Promise<Response>;
// ---cut---
import { documented } from "@tetsujs/openapi";

export const files = documented(readFile, {
  hidden: true,
  responses: [
    {
      status: 200,
      description: "The file",
      contentType: "*/*",
      headers: { etag: { schema: { type: "string" } } },
    },
    { status: 304, description: "Not modified" },
    { status: 404, description: "No such file", error: "NOT_FOUND" },
  ],
});
```

- Its responses are the route's own: a route that mounts it needs no
  `schema.response`, and gets no placeholder `200`.
- `hidden: true` keeps every route that mounts it out of the document,
  unless the route says `docs: { hidden: false }`. The route's own word
  wins either way.
- An arrow that wraps the handler is what the route then mounts, and it
  says nothing. Hide such a route, or describe it, on the route itself.

Annotate a handler whose type is already settled, such as a package's. An
arrow written inside `documented()` on a route does not get the route's
context and does not compile; a route of your own describes its statuses
in its response map.

## An error format of your own

An application can answer every failure in a format of its own with one
`onError` hook, as [Errors](/docs/concepts/errors/#an-error-format-of-your-own) shows. The document cannot
read that hook, so describe the same format with `errors`. Here the format is
`{ code, message }`:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import type { ErrorBody } from "@tetsujs/core";
import { hook, HttpError } from "@tetsujs/core";

const info = { title: "Items API", version: "1.0.0" };
const inOurFormat = hook.onError((ctx) =>
  ctx.error instanceof HttpError
    ? Response.json(ctx.error.body as ErrorBody, { status: ctx.error.status })
    : undefined,
);
const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const api = items();
// ---cut---
import { docs, type ErrorFormat } from "@tetsujs/openapi";

const errors: ErrorFormat = {
  schema: ({ error, message, fields }) => ({
    type: "object",
    required: ["code", "message", ...Object.keys(fields)],
    properties: {
      code: error ? { type: "string", const: error } : { type: "string" },
      message: { type: "string", ...(message ? { examples: [message] } : {}) },
      ...fields,
    },
  }),
  discriminator: "code",
};

createApp({
  hooks: { onError: [inOurFormat] },
  routes: [api, docs({ info, errors })],
});
```

| `errors` field | |
| --- | --- |
| `schema` | builds the JSON Schema of one failure from `{ status, error, message, fields }`. `error` is the code when known; `fields` holds what the failure carries besides, such as `issues` or `retryAfter` |
| `discriminator` | the top-level field that holds the code. Statuses are discriminated on it, and a route's own envelope is recognized by it. None unless named |
| `code` | reads the code from a schema a route or hook declared, for a format that nests its code. By default, the `const` of the discriminator's field |

The hook and `errors` describe one format in two places. Keep a test that
provokes each kind of failure, the unexpected one included, and checks it
with [`assertDescribed`](#testing-against-the-document).

## Testing against the document

`@tetsujs/openapi/testing` checks a response a test provoked against what the
document says:

```ts twoslash
import { expect, test } from "bun:test";
import { controller, createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";

const sessions = controller("Sessions", () => ({
  create: route({ method: "POST", path: "/session", handler: () => ({ ok: true }) }),
}));
const app = createApp({ routes: sessions() });
const request = serve(app);
const info = { title: "Sessions API", version: "1.0.0" };
const body = JSON.stringify({ code: "000000" });
// ---cut---
import { openapi } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";

const { document } = openapi(app, { info });

test("a wrong code is what the document says", async () => {
  const res = await request("/session", { method: "POST", body });

  await assertDescribed(document, "POST /session", res);
});
```

It throws unless the operation declares the status and the body fits one of
that status's alternatives, and lists every problem:

```text
POST /session answered 403, which the document does not describe:
- error "CAPTCHA_FAILED", which its 403 does not list: ACCOUNT_DISABLED, CSRF_HEADER_REQUIRED
```

The second argument is the method and the path the test requested, such as
`"GET /users/42"`; it is matched against the document's path templates. The
body is read from a clone, so the test can still read the response. Its
media type is compared without regard to case, and a range in the document,
such as `image/*` or `*/*`, takes every type in it. The body is parsed and
checked only under `application/json` or a `+json` type; under any other
type, an empty body passes, as an export with no rows does.

| Option | Default | |
| --- | --- | --- |
| `validate` | none | `(schema, body) => true \| string`: checks the whole body with a JSON Schema validator of your choice, such as `(schema, body) => ajv.validate(schema, body) \|\| ajv.errorsText()`. Without it, only the top level is compared: required fields and `const` fields |
| `headers` | none | headers the status must declare when the response carries them, such as `["retry-after"]` |

A header the status declares as required, such as `location` or
`set-cookie`, must be on the response even without `headers`. See
[Testing](/docs/guides/testing/).

## Using the document directly

To write the document to a file in CI or feed it to a client generator, call
`openapi()`. It takes `info`, `servers`, `errors` and `tags`, and mounts
nothing:

```ts twoslash
import { createApp } from "@tetsujs/core";

const app = createApp({ routes: [] });
// ---cut---
import { openapi } from "@tetsujs/openapi";

const { document, warnings } = openapi(app, {
  info: { title: "Users API", version: "1.0.0" },
});

await Bun.write("openapi.json", JSON.stringify(document, null, 2));
```

Each warning has a `route`, such as `GET /path` (empty for the document as a
whole), and a `message`.

`docsPage({ ui, documentUrl, title?, assets? })` returns the page's HTML, to
serve it from a route of your own. `documentUrl` is where the page fetches
the document from, and `title` defaults to `"API documentation"`.

## Warnings

A route that cannot be fully described is still documented, and the gap is
reported instead of failing startup:

```text
[openapi] POST /api/users: the body schema does not emit JSON Schema
```

Warnings are raised for:

- a validator that does not emit JSON Schema, or a conversion that throws;
- two routes that map to the same OpenAPI path, such as `/files/*` and
  `/files/:wildcard`; the second replaces the first in the document;
- a reference that leads nowhere. Recursive and named schemas emit
  references (`#`, `#/$defs/…`) that no longer resolve once embedded in the
  document: Zod's recursive getters and `.meta({ id })`, ArkType's scopes,
  Valibot's `lazy`. TypeBox's `Type.Cyclic` is described correctly;
- a tag used but not described in `tags`, or described and not used;
- two different security schemes under one `name`. The first is kept.

`docs()` prints each warning with `console.warn`, or passes it to
`onWarning`.

## The page and your origin

The page loads its renderer (Scalar, Swagger UI or Redoc) from jsDelivr and
runs it on the application's origin, with that origin's cookies. The default
files are pinned to an exact version with a Subresource Integrity hash, so
the browser refuses a file the CDN changed. That still makes it someone
else's code running next to your users' sessions.

Where the origin carries a session, serve the document alone:

```ts twoslash
import { docs } from "@tetsujs/openapi";

const info = { title: "Users API", version: "1.0.0" };
// ---cut---
const documentOnly = docs({ info, ui: false });
```

Or host the renderer yourself, or pin your own copy with its hash:

```ts twoslash
import { docs } from "@tetsujs/openapi";

const info = { title: "Users API", version: "1.0.0" };
// ---cut---
const pinned = docs({
  info,
  assets: {
    script: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js",
    integrity: { script: "sha384-…" },
  },
});
```

`curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A` prints the
hash; prefix it with `sha384-`. Swagger UI also needs `style` and
`integrity.style`.

A `content-security-policy` that denies scripts from other origins, such as
`apiPolicy` of [`@tetsujs/secure-headers`](/docs/packages/secure-headers/#content-security-policy),
leaves the page blank. That page shows how to lift the policy for this route.

## Exports

- `docs` and `DocsController`, with `DocsOptions`.
- `openapi`, with `OpenApiOptions`, `GeneratorResult` and `GeneratorWarning`.
- `docsPage`, with `DocsPageOptions`, `DocsUi` and `DocsAssets`.
- `documented` and `secured`, with `HookDocs`, `HandlerDocs`,
  `DocumentedResponse`, `DocumentedHeader`, `SecurityRequirement`,
  `SecurityAlternatives`, `SecurityScheme` and `HookContributions`.
- `ErrorFormat` and `DocumentedFailure`, for an error format of your own.
- `JsonSchema`, `JsonSchemaKeywords` and `JsonSchemaType`, for JSON Schema
  written by hand.
- The document's types: `OpenApiDocument`, `DocumentInfo`, `DocumentServer`,
  `PathItemObject`, `OperationObject`, `ParameterObject`, `ResponseObject`,
  `HeaderObject`, `ContentMap` and `TagObject`.
- From `@tetsujs/openapi/testing`: `assertDescribed`, with `AssertDescribedOptions`.
