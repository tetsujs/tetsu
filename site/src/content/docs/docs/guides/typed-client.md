---
title: Typed client from OpenAPI
description: A typed client for a Tetsu API, generated from its OpenAPI document with openapi-typescript and openapi-fetch or hey-api, and kept honest in CI.
sidebar:
  order: 11
---

This guide gives the API's consumers — a frontend, another service — a
client whose paths, parameters, bodies and errors are typed, generated
from the OpenAPI document the application already describes itself with.

## The document is the boundary

Some frameworks type a client from the server's own source: Elysia's Eden
and Hono's RPC client import the application's type and infer every call
from it. There is no generation step, and the price is that the client
compiles against the server — it needs the server's code, its
dependencies' types and a compatible TypeScript, and every change on the
server is re-checked in every client.

Tetsu's boundary is the [OpenAPI document](/docs/packages/openapi/)
instead. It is generated from the routes as they are declared — paths,
parameters, bodies, statuses, the error envelopes — and it is a file: a
client in another repository, or in another language, reads it without
seeing a line of the server, and a change to it is a diff a reviewer
reads. The cost is one step, generating the types from the document, and
the types are exactly as good as the document is.

## Serving the document

Mount [`docs()`](/docs/packages/openapi/#usage) next to your controllers,
and the application serves its document at `/openapi.json`:

```ts twoslash
import { z } from "zod";
const User = z.object({ id: z.number(), name: z.string() });
const UserNotFound = z.object({ status: z.literal(404), message: z.string(), error: z.literal("USER_NOT_FOUND") });
// ---cut---
import { controller, createApp, httpError, route } from "@tetsujs/core";
import { docs } from "@tetsujs/openapi";

const usersController = controller("Users", () => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: {
      params: z.object({ id: z.coerce.number() }),
      response: { 200: User, 404: UserNotFound },
    },
    handler: (ctx) => {
      if (ctx.params.id !== 1) throw httpError(404, "USER_NOT_FOUND");

      return { id: 1, name: "Ada" };
    },
  }),
}));

export const app = createApp({
  routes: [usersController(), docs({ info: { title: "Users API", version: "1.0.0" }, ui: false })],
});
```

`ui: false` serves the document without the page that renders it; leave
it out to get the page at `/docs` as well.

## Generating the types

[`openapi-typescript`](https://openapi-ts.dev) turns the document into
TypeScript types, from a file or from a URL:

```bash
bunx openapi-typescript http://localhost:3000/openapi.json -o src/api.d.ts
```

The output is one `paths` interface, keyed by the document's paths, with
`components` and `operations` beside it. Nothing in it runs; it is types
only, so it costs the client nothing at runtime.

## Calling the API

[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) is a thin
`fetch` wrapper typed by that `paths` interface. The file below stands in
for the generated one, shaped as `openapi-typescript` writes it for the
application above:

```ts twoslash
// @filename: api.d.ts
export interface paths {
  "/users/{id}": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: operations["usersGet"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export interface components {
  schemas: {
    UserNotFound: { status: 404; message: string; error: "USER_NOT_FOUND" };
    ValidationFailed: {
      issues: { message: string; path: (string | number)[] }[];
      status: 422;
      message: string;
      error: "VALIDATION_FAILED";
    };
    InternalServerError: { status: 500; message: string; error: "INTERNAL_SERVER_ERROR" };
  };
}
type Json<T> = { headers: { [name: string]: unknown }; content: { "application/json": T } };
export interface operations {
  usersGet: {
    parameters: { query?: never; header?: never; path: { id: number }; cookie?: never };
    requestBody?: never;
    responses: {
      200: Json<{ id: number; name: string }>;
      404: Json<components["schemas"]["UserNotFound"]>;
      422: Json<components["schemas"]["ValidationFailed"]>;
      500: Json<components["schemas"]["InternalServerError"]>;
    };
  };
}
// @filename: client.ts
// ---cut---
import createClient from "openapi-fetch";
import type { paths } from "./api";

const api = createClient<paths>({ baseUrl: "https://api.example.com" });

const { data, error } = await api.GET("/users/{id}", {
  params: { path: { id: 42 } },
});

if (error) {
  const code = error.error;
  //    ^?
  console.log(code);
} else {
  console.log(data.name);
}
```

The path is checked against the document, `id` has to be a number, and
`data` is the `200` body. A path that does not exist, or a parameter left
out, is a compile error in the client.

## Errors are in the document

`error` is the body of whichever other status came back, typed as the
union of what the document lists for the operation. That includes the
failures the framework answers by itself — a `422` when validation fails,
a `500` — because the document describes them on every route where they
can happen, in the same envelope the server sends. See
[Errors](/docs/concepts/errors/).

Every envelope carries its code in `error` as a constant, so a client
branches on it rather than on the message, which is written for people
and may change. Each code is one definition in `components`, named after
it — `USER_NOT_FOUND` is `UserNotFound` — so a generated client has one
type per failure. A status that only envelopes answer with carries a
`discriminator` on `error`, which generators that understand it use to
narrow.

An envelope that is thrown but not declared is not in the document. A
route that answers `404` lists it in its response map, as `usersGet` does
above; a hook that refuses describes its refusal with
[`documented()` or `secured()`](/docs/packages/openapi/#documenting-hooks),
as the [rate limiter](/docs/packages/rate-limit/) does for its `429`. An
application with an error format of its own tells the document with
[`errors`](/docs/packages/openapi/#an-error-format-of-your-own).

## Operation ids

A generator that writes functions rather than a path-keyed client names
them after each operation's `operationId`. Tetsu builds it from the
controller's name and the route's field — `get` in
`controller("Users", …)` is `usersGet` — so the names a client sees come
from names you wrote, and renaming a variable changes nothing.

Renaming a controller does change them, and that is where a reviewer sees
it. On a public API, state the id on every route with
`docs: { operationId }`, so it cannot change by accident. Two routes that
arrive at the same id stop the application at startup; nothing is renamed
behind your back. See [Operation ids](/docs/packages/openapi/#operation-ids).

## An SDK instead

[`@hey-api/openapi-ts`](https://heyapi.dev) generates a client with a
function per operation, named after its `operationId`, together with the
types:

```bash
bunx @hey-api/openapi-ts -i http://localhost:3000/openapi.json -o src/client
```

Which to use is a matter of taste: `openapi-fetch` keeps the calls in the
shape of HTTP, paths and methods; an SDK hides them behind functions. Both
read the same document, and so does any generator in any other language.

## Where the client lives

The client belongs to its consumers, not to the server: in the frontend's
repository, or in a package of its own in a monorepo that other services
depend on. The server's only part is the document, and there are two ways
to hand it over:

- **Served**, as above, and read by the client's build from a running
  instance — a staging server, or the server started in CI.
- **Written to a file** and committed next to the server's code, where
  the client's build fetches it, or a monorepo package reads it directly.

The second makes every change to the API a change to a file, which is also
what makes the check below possible. `openapi()` builds the document
without serving it; the script imports the application, not the server,
so nothing starts listening:

```ts twoslash
// @filename: app.ts
import { createApp } from "@tetsujs/core";
export const app = createApp({ routes: [] });
// @filename: openapi.ts
// ---cut---
import { openapi } from "@tetsujs/openapi";
import { app } from "./app";

const { document, warnings } = openapi(app, { info: { title: "Users API", version: "1.0.0" } });

for (const warning of warnings) console.error(`${warning.route}: ${warning.message}`);

if (warnings.length > 0) process.exit(1);

await Bun.write("openapi.json", `${JSON.stringify(document, null, 2)}\n`);
```

A warning means part of a route could not be described — most often a
schema from a validator that emits no JSON Schema — so the script fails
rather than write a document with a hole in it. Keeping the application in
a module of its own, and serving it from another, is the layout
[Structuring an application](/docs/guides/structuring/) describes.

## Checking the document in CI

With the document committed, CI regenerates it and fails when it differs
from the committed file:

```bash
bun scripts/openapi.ts
git diff --exit-code openapi.json
```

A pull request that changes the API without updating the document fails,
and one that updates it shows the change to the contract next to the code
that made it: a renamed field, a status a route stopped declaring, an
operation id that moved. Whether a change breaks existing clients is still
a reviewer's call; a tool such as `oasdiff` compares two documents and
lists the changes that do.

A test can make the same check from the other side: that a response the
application really sends is one its document describes. That is
[`assertDescribed`](/docs/packages/openapi/#testing-against-the-document),
and it catches a handler that answers what the document never promised.
