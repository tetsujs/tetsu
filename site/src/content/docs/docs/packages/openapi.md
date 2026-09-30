---
title: "@tetsujs/openapi"
description: An OpenAPI 3.1 document and a docs page, generated from the routes you already declared.
sidebar:
  order: 2
  label: "@tetsujs/openapi"
---

`@tetsujs/openapi` reads an application's routes and produces an OpenAPI 3.1
document, and a page that renders it. Nothing is written twice: the paths, the
parameters, the bodies and the responses come from the schemas and the response
maps the routes already have. To turn the document into a typed client, see
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

`/openapi.json` serves the document and `/docs` renders it. The document is
built once, at startup, so anything that cannot be described is reported before
the first request.

`docs()` is an ordinary controller: put it in a group to move it under a prefix,
guard it with hooks, or leave it out in production. Its own two routes are left
out of the document. A `docs()` documents the application it is mounted in, all
of it.

### The page runs someone else's code on your origin

The page loads its renderer, Scalar, Swagger UI or Redoc, from jsDelivr and runs
it on the application's origin, with that origin's cookies. If a session cookie
lives there, a renderer that is not what it should be acts as the signed-in
user. The defaults are pinned to an exact version with a Subresource Integrity
hash, so a file the CDN changes is refused by the browser. That does not make the
renderer yours, and what it loads in turn is not covered.

Where the origin carries a session, serve the document alone:

```ts twoslash
import { docs } from "@tetsujs/openapi";

const info = { title: "Users API", version: "1.0.0" };
// ---cut---
const documentOnly = docs({ info, ui: false });
```

`/openapi.json` is served and there is no page. For a page anyway, host the
renderer yourself or pin your own copy, with its hash:

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

```bash
curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
```

prints the hash, to be prefixed with `sha384-`. `assets` also takes a `style`
URL and an `integrity.style` hash, which Swagger UI needs.

The page also meets a `content-security-policy` that denies everything, such as
`apiPolicy` of [`@tetsujs/secure-headers`](/docs/packages/secure-headers/#content-security-policy):
it loads its renderer from a CDN, so the page is blank. That page shows how to
remove the policy for this route.

## Options

| Option | Default | |
| --- | --- | --- |
| `info` | required | the document's `info`: title, version, description |
| `servers` | none | where the API is reachable |
| `path` | `/openapi.json` | where the document is served |
| `uiPath` | `/docs` | where the page is served |
| `ui` | `"scalar"` | `"scalar"`, `"swagger-ui"`, `"redoc"`, or `false` for no page |
| `title` | the document's title | the page's title |
| `assets` | the renderer on jsDelivr, pinned | your own renderer URLs, with `integrity` hashes |
| `documentSelf` | `false` | include `/openapi.json` and `/docs` in the document |
| `onWarning` | `console.warn` | receives what could not be described |
| `errors` | the framework's envelope | an error format of your own, see [below](#an-error-format-of-your-own) |
| `tags` | none | what each tag is, in the order the sidebar lists them, see [below](#tags) |

`path` and `uiPath` are checked like a route's path, and they are where the two
routes are served, under the prefix of any group `docs()` is mounted in. The page
finds the document wherever that puts it. With `documentSelf`, the two
routes are documented under the tag `docs`, which is described for you unless
you describe it in `tags`. With `ui: false`, `uiPath`, `title` and `assets` are
not used.

`openapi()`, described [below](#using-the-document-directly), takes `info`,
`servers`, `errors` and `tags`.

## How a route becomes an operation

Every part of an operation comes from somewhere the application already wrote,
by a rule:

| In the document | Comes from | Rule |
| --- | --- | --- |
| the path | the route's `path`, under its groups' prefixes | `/users/:id` becomes `/users/{id}` |
| `operationId` | `docs.operationId`, or the controller's name and the field | `setAvatar` in `controller("Users", …)` becomes `usersSetAvatar`; see [Operation ids](#operation-ids) |
| `summary`, `description`, `tags`, `deprecated` | the route's `docs` | as written |
| parameters | `schema.params`, `query`, `headers`, `cookies` | required as the schema says |
| the request body | `schema.body` and `bodyType` | media types from `bodyType`; required unless `text` or `stream` |
| `security` | `secured()` hooks, of every level the route runs under | every hook required together; `anyOf` inside one hook is the alternatives |
| the statuses | the route's `schema.response`, the hooks' `documented()` and `secured()`, the framework | one schema is `200`, a map its statuses, `null` or an entry without `body` a status without a body; with no `schema.response` at all, `200`; the framework's `422`, `400`, `413`, `500` where they can happen, see [Responses the framework adds](#responses-the-framework-adds) |
| a status's body | everything answering with that status | one flat `anyOf`, the route's own first, the same body once |
| an error envelope | any of them | one definition per status and code in `components`, named after the code; the route's own kept |
| `discriminator` | the envelopes of a status | on `error`, or the format's field, when every alternative is an envelope |
| a status's description | the schemas' `description`, the hooks', the framework's | one is the description, several a list led by code, none the reason phrase |
| a status's headers | the route's entry, `{ body, headers, cookies }`, and the hooks' `documented()` headers | the route's required as its schema says, a property's `description` the header's; its cookies one `set-cookie` header listing them; a hook's possible, not required; the route's wins a name both give |
| the document's `tags` | the `tags` option | in its order, then the tags routes use and it leaves out |

`docs: { hidden: true }` leaves a route out of the document; it is served as
before. Socket endpoints are left out as well: a handshake is a `GET`, but
OpenAPI has no way to describe what happens after it. A route with no
`schema.response` is documented as `200`. Its handler may still answer `204` by
returning nothing, which only a declared `204: null` says.

Schemas are described through Standard Schema's JSON Schema support: Zod,
Valibot, ArkType and [`@tetsujs/typebox`](/docs/packages/typebox/) provide it.
See [Responses](/docs/concepts/responses/) for the response map.

## Tags

A route names its tags in `docs: { tags }`; the document says what each one is:

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

The order of the keys is the order of the sections a renderer lists. A tag the
routes use and `tags` leaves out is listed after them, in the order the routes
first use it, and reported: it is usually one tag spelled two ways, `sign_in`
next to `sign-in`. So is a tag described and used by no operation. Without
`tags` the document lists none, and nothing is reported.

Several surfaces with a document each, such as a public API and an admin one,
are several applications, each with its own `docs()` and only the tags of its
own routes:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import { docs } from "@tetsujs/openapi";

const info = { title: "Shop API", version: "1.0.0" };
const adminInfo = { title: "Shop admin API", version: "1.0.0" };
const orders = controller("Orders", () => ({
  list: route({ method: "GET", path: "/orders", docs: { tags: ["orders"] }, handler: () => [] }),
}));
const users = controller("Users", () => ({
  list: route({ method: "GET", path: "/users", docs: { tags: ["users"] }, handler: () => [] }),
}));
// ---cut---
const api = Bun.serve({
  ...createApp({ routes: [orders(), docs({ info, tags: { orders: "Orders" } })] }),
  port: 3000,
});

const admin = Bun.serve({
  ...createApp({ routes: [users(), docs({ info: adminInfo, tags: { users: "Users" } })] }),
  port: 3001,
});
```

## Operation ids

A generated client names its methods after the `operationId`s, so they are a
contract, and every one comes from a name you wrote:

| Route | `operationId` |
| --- | --- |
| with `docs: { operationId }` | as written |
| in `controller("Users", …)` as `setAvatar` | `usersSetAvatar` |
| in a class `UsersController` as `setAvatar` | `usersSetAvatar` |
| in an object literal as `setAvatar` | `setAvatar` |
| mounted on its own, `POST /auth/code` | `postAuthCode` |

Two routes arriving at the same id stop the application at startup, naming both.
Nothing is renamed behind your back, which would change a method in someone's SDK
the day a route is added. Give one of them `docs.operationId`, or its controller
a name of its own. On a public API, state the id on every route: it is then
visible, and a change to it is a change a reviewer sees.

```ts twoslash
import { route } from "@tetsujs/core";

declare const queue: { drain(): Promise<void> };
// ---cut---
const drain = route({
  method: "POST",
  path: "/internal/drain",
  docs: { summary: "Drain the queue", operationId: "drainQueue", hidden: true },
  handler: () => queue.drain(),
});
```

## Responses the framework adds

Failures the framework answers by itself are documented on every route where they
can happen, in the same error envelope the server sends:

| Status | `error` | When |
| --- | --- | --- |
| `422` (or the configured validation status) | `VALIDATION_FAILED` | a request part failed its schema |
| `400` | `MALFORMED_JSON` / `MALFORMED_FORM` | the body could not be parsed |
| `413` | `BODY_TOO_LARGE` | the body exceeded `maxBodySize` |
| `500` | `INTERNAL_SERVER_ERROR` | any unhandled failure |

The statuses are filled in from the options the application actually runs with,
so the document states the status configured. The `error` code is a constant in
each schema, so a generated client can tell failures apart by it. A status the
route declares itself is kept, and the framework's failures for the same status
are listed next to it. See [Framework error codes](/docs/reference/error-codes/).

Every envelope, the framework's, a hook's, or one the route declares itself, is
one definition in `components` per status and code, named after the code
(`ITEM_NOT_FOUND` is `ItemNotFound`), so a generated client gets one type per
failure. A schema is recognized as an envelope when its `error` is required and a
single string. When the route and a hook both describe one code, the route's
definition is kept; if the other one has different fields, the generator warns.
A union the route declares joins the other failures of its status as one flat
`anyOf`.

When every alternative of a status is an envelope, the union carries a
`discriminator` on `error`, with the mapping from each code to its definition,
and a generated client narrows on the code.

A status is described by what answers with it. The route's part is the
`description` of the schema it declares (`.describe()` in Zod and ArkType,
`v.description()` in Valibot, `{ description }` in TypeBox) for any status, a
`200` as much as a `404`. A union described as a whole is one description, one
described branch by branch is one per branch. A hook's part is its `documented()`
description, the framework's its own. One description is the status's
description; several are a list, each led by its code:

```md
- `ACCOUNT_DISABLED`: this account is disabled
- `CAPTCHA_FAILED`: the captcha token is missing or did not pass
```

A status nothing describes keeps its reason phrase: `Not Found`, `Successful
response`.

## An error format of your own

Every failure reaches the application's `onError` hooks: a thrown `HttpError`, a
validation or body failure, a `404`, a `405`, a rate limit's refusal, and an
error nothing expected. So one hook answers all of them in your format:

```ts twoslash
import type { ErrorBody } from "@tetsujs/core";
import { hook, HttpError, reportFailure } from "@tetsujs/core";

export const inOurFormat = hook.onError((ctx) => {
  const { error } = ctx;

  if (error instanceof HttpError) {
    const { status, error: code, ...rest } = error.body as ErrorBody;

    return Response.json({ code, ...rest }, { status });
  }

  reportFailure(ctx, "unhandled", error);

  return Response.json(
    { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" },
    { status: 500 },
  );
});
```

An error the hook answers is one nothing else reports: `reportError` hears of a
failure only when no `onError` hook answered it. So the hook that answers the
unexpected ones, a database gone or a `TypeError`, reports them itself. Left out,
they answer in your format and never reach the error tracker. See
[Errors](/docs/concepts/errors/).

The document is generated from the routes, not from that hook, so it is told the
same format with `errors`:

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

`schema` describes one failure from what the generator knows of it: its `status`,
its code when known as `error`, an example `message`, and in `fields` what it
carries besides: `issues` for a validation failure, `retryAfter` for a rate
limit, a hook's own `fields`. It is used for the framework's failures and the
hooks' refusals alike.

`discriminator` names the top-level field that holds the code. Statuses of
envelopes are then discriminated on it, and a route's own envelope is recognized
by it: a `{ code: "ITEM_NOT_FOUND", … }` the route declares is the same
definition as a hook's. A format that nests its code has no top-level field to
name. It gives `code` instead, reading the code from a route's schema:

```ts twoslash
import type { ErrorFormat } from "@tetsujs/openapi";

const nested: Pick<ErrorFormat, "code"> = {
  code: (schema) => {
    const error = schema.properties?.error;
    const code = typeof error === "object" ? error.properties?.code : undefined;

    return typeof code === "object" && typeof code.const === "string" ? code.const : undefined;
  },
};
```

| `errors` field | |
| --- | --- |
| `schema` | builds the body of one failure from `{ status, error, message, fields }`, as JSON Schema |
| `discriminator` | the top-level field that holds the code; none unless named |
| `code` | reads the code from a schema a route or hook declared; by default the `const` of the discriminator's field |

The hook and `errors` describe one format in two places. The core knows nothing
about documents, and a function cannot be read for the shape it returns, so keep
a test that holds them together: provoke the failures, the unexpected one
included, and check each against the document with
[`assertDescribed`](#testing-against-the-document):

```ts twoslash
import { expect, test } from "bun:test";
import { controller, createApp, hook, HttpError, route } from "@tetsujs/core";
import type { ErrorBody } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";

const info = { title: "Items API", version: "1.0.0" };
const inOurFormat = hook.onError((ctx) =>
  ctx.error instanceof HttpError
    ? Response.json(ctx.error.body as ErrorBody, { status: ctx.error.status })
    : undefined,
);
const items = controller("Items", () => ({
  create: route({ method: "POST", path: "/items", handler: () => ({ id: 1 }) }),
}));
const api = items();
const errors = { schema: () => ({ type: "object" as const }) };
// ---cut---
import { openapi } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";

const boom = route({
  method: "GET",
  path: "/boom",
  handler: () => {
    throw new Error("boom");
  },
});
const app = createApp({ hooks: { onError: [inOurFormat] }, routes: [api, boom] });
const request = serve(app);
const { document } = openapi(app, { info, errors });

test("failures are what the document says", async () => {
  await assertDescribed(document, "POST /items", await request("/items", { method: "POST", body: "{}" }));
  await assertDescribed(document, "GET /boom", await request("/boom"));
});
```

## Documenting hooks

A hook that answers by itself, an auth check or a limiter, can say so, and every
route it guards is documented accordingly. `secured()` adds a security scheme,
`documented()` adds responses:

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

A response with an `error` code is the framework's envelope, defined once in
`components` and named after the code. `fields` adds what the hook puts next to
`status`, `message` and `error`, each always present. `headers` adds what it sets
on the response, possible rather than required. Both are JSON Schema written by
hand, typed keyword by keyword (`JsonSchema`), so a misspelled keyword does not
compile. A hook whose body is not the envelope passes a `schema` instead.
`message` gives an example of the envelope's message.

`secured()` takes a requirement with these fields:

| Field | Default | |
| --- | --- | --- |
| `name` | required | the name the scheme is registered under in `components` |
| `scheme` | required | the scheme, as OpenAPI spells it: `http`, `apiKey`, `oauth2`, `openIdConnect`, `mutualTLS` |
| `scopes` | none | OAuth2 scopes |
| `status` | `401` | the status an unauthenticated request gets |
| `description` | none | how the refusal is described |
| `error` | none | the `error` code the refusal carries, as a `const` |
| `message` | none | an example of the refusal's message |

Both return a copy of the hook with its type unchanged, so an annotated hook
goes into a stack like any other, and a hook used elsewhere is not changed
behind its author's back. A hook annotated once is documented everywhere it runs:
application and group chains are merged into every route's at startup, so a guard
mounted on a group documents the group's operations without repeating itself.

Hooks from [`@tetsujs/rate-limit`](/docs/packages/rate-limit/) are already
documented this way. A scheme is identified by its `name`: the same one mounted
twice is one requirement, and two different schemes under one name are reported,
with the first one kept.

Every hook of a route runs, so every scheme its hooks carry is required together:
a route behind a CSRF check and a captcha is documented as needing both, one
entry of `security`. In OpenAPI, separate entries mean any one of them will do.
Two hooks of one scheme require the scopes of both.

"Either" lives inside one hook. A hook that accepts a session cookie or a bearer
token says so with `anyOf`, and the document lists every combination a client may
bring:

```ts twoslash
import { hook, HttpError } from "@tetsujs/core";
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

With a CSRF check on the same route, the document says `security: [{ session: [],
csrf: [] }, { bearer: [], csrf: [] }]`.

## Using the document directly

When the document itself is the output, written to a file in CI or fed to a
client generator, call the generator:

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

`openapi()` returns the document and the `warnings`, each with the `route` it is
about, as `GET /path` or empty for the document as a whole, and a `message`. It
mounts and serves nothing, and the document is data.

`docsPage()` renders the page on its own, for serving it elsewhere:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
import { docsPage } from "@tetsujs/openapi";

const page = docsPage({ ui: "scalar", documentUrl: "/openapi.json" });

const ui = route({
  method: "GET",
  path: "/reference",
  handler: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
```

| `docsPage()` option | Default | |
| --- | --- | --- |
| `ui` | required | `"scalar"`, `"swagger-ui"` or `"redoc"` |
| `documentUrl` | required | where the document is served; the page fetches it from there |
| `title` | `"API documentation"` | the browser title |
| `assets` | the renderer on jsDelivr, pinned | `{ script, style?, integrity? }` |

## Testing against the document

`@tetsujs/openapi/testing` checks a response a test provoked against the
operation the document describes:

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

It throws unless the status is declared and the body fits one of the alternatives
its status describes, listing every problem at once:

```text
POST /session answered 403, which the document does not describe:
- error "CAPTCHA_FAILED", which its 403 does not list: ACCOUNT_DISABLED, CSRF_HEADER_REQUIRED
```

The operation is named as the test called it, a method and the path it
requested, matched against the document's templates. The body is read from a
clone, so the test can still read the response. Without a validator only the top
level of the body is compared: required fields, and fields that are a `const`,
which is where an envelope keeps its code.

| Option | Default | |
| --- | --- | --- |
| `validate` | none | `(schema, body) => true \| string`: checks the whole body with the JSON Schema validator of your choice, given a schema that stands on its own; return `true`, or what is wrong |
| `headers` | none | headers the status must declare when the response carries them, such as `retry-after` |

```ts twoslash
import { createApp } from "@tetsujs/core";
import type { OpenApiDocument } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";

declare const document: OpenApiDocument;
declare const res: Response;
declare const ajv: { validate(schema: object, body: unknown): boolean; errorsText(): string };
// ---cut---
await assertDescribed(document, "POST /session", res, {
  validate: (schema, body) => ajv.validate(schema, body) || ajv.errorsText(),
  headers: ["retry-after"],
});
```

Only the headers named are checked, because a response carries headers no
document describes, `content-type` and `x-request-id` among them. The other way
needs no list: a header the status declares required, such as a `location` or a
`set-cookie`, is one the response must carry.

The core does not check a thrown error against the route's response map, because
a guard's refusal would be reported on every route it runs on. A test asks about
the one response it provoked. See [Testing](/docs/guides/testing/).

## Warnings

A route is still documented when part of it cannot be described, and the gap is
reported instead of failing the startup:

```text
[openapi] POST /api/users: the body schema does not emit JSON Schema
```

This happens with a validator that does not emit JSON Schema, a schema whose
conversion throws, and two routes that map to the same OpenAPI path (`/files/*`
and `/files/:wildcard` are both `/files/{wildcard}`; the second replaces the
first in the document, and the warning says so). `docs()` prints each warning
with `console.warn`; `onWarning` receives them instead.

It also happens with a recursive or named schema. A schema is embedded as the
validator emits it, and the references inside it, `#` for its own root,
`#/$defs/…` for a definition next to it, resolve against the document's root once
embedded, where they lead nowhere. Zod's recursive getters and `.meta({ id })`,
ArkType's scopes and Valibot's `lazy` emit them. TypeBox's `Type.Cyclic` names
itself with `$id` and is described as it is.

Other warnings name a tag used and not described in `tags`, a tag described and
used by no operation, and a security scheme claimed under one name with two
different definitions.

## Exports

- `docs` and `DocsController`: the controller, with `DocsOptions`.
- `openapi`, with `OpenApiOptions`, `GeneratorResult` and `GeneratorWarning`.
- `docsPage`, with `DocsPageOptions`, `DocsUi` and `DocsAssets`.
- `documented` and `secured`, with `HookDocs`, `DocumentedResponse`,
  `DocumentedHeader`, `SecurityRequirement`, `SecurityAlternatives`,
  `SecurityScheme` and `HookContributions`.
- `ErrorFormat` and `DocumentedFailure`, for an error format of your own.
- `JsonSchema`, `JsonSchemaKeywords` and `JsonSchemaType`, for JSON Schema written
  by hand.
- The types of the document: `OpenApiDocument`, `DocumentInfo`, `DocumentServer`,
  `PathItemObject`, `OperationObject`, `ParameterObject`, `ResponseObject`,
  `HeaderObject`, `ContentMap` and `TagObject`.
- From `@tetsujs/openapi/testing`: `assertDescribed` and its options.
