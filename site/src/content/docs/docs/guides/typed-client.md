---
title: Typed client from OpenAPI
description: Generate a typed client for a Tetsu API from its OpenAPI document, with openapi-typescript and openapi-fetch or hey-api, and keep the document in sync in CI.
sidebar:
  order: 11
---

This guide gives the API's consumers — a frontend, another service — a
client with typed paths, parameters, bodies and errors. It is generated
from the [OpenAPI document](/docs/packages/openapi/) that Tetsu builds from
your routes.

Tetsu has no RPC client that imports the server's types, as Elysia's Eden
or Hono's client do. The document is the boundary instead: a client in
another repository or another language reads it without the server's
code, and a change to the API shows up as a diff of one file. The cost is
one generation step.

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

`ui: false` serves only the document; leave it out to also get a
documentation page at `/docs`.

## Generating the types

[`openapi-typescript`](https://openapi-ts.dev) turns the document into
TypeScript types, from a file or from a URL:

```bash
bunx openapi-typescript http://localhost:3000/openapi.json -o src/api.d.ts
```

The output is types only, with a `paths` interface keyed by the
document's paths. It costs nothing at runtime.

## Calling the API

[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) is a thin
`fetch` wrapper typed by that `paths` interface:

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

The path is checked against the document, `id` must be a number, and
`data` is the `200` body. A wrong path or a missing parameter is a compile
error.

## Errors are in the document

`error` is the body of any other status, typed as the union of what the
document lists for the operation. That includes the failures the
framework answers by itself, such as `422` for a validation failure and
`500`. Branch on the `error` code, not on the message, which is written for
people and may change. See [Errors](/docs/concepts/errors/).

An error that is thrown but not declared is not in the document. A route
lists its own in its response map, as `404` above. A hook that refuses
describes its refusal with
[`documented()` or `secured()`](/docs/packages/openapi/#documenting-hooks).
A custom error format is described with
[`errors`](/docs/packages/openapi/#an-error-format-of-your-own).

## Operation ids

A generator that writes a function per operation names it after the
`operationId`. Tetsu builds it from the controller's name and the route's
field: `get` in `controller("Users", …)` is `usersGet`. Renaming the
controller renames the functions, so on a public API state the id on each
route with `docs: { operationId }`. Two routes with the same id are an
error when the document is built. See
[Operation ids](/docs/packages/openapi/#operation-ids).

## An SDK instead

[`@hey-api/openapi-ts`](https://heyapi.dev) generates the types and a
function per operation:

```bash
bunx @hey-api/openapi-ts -i http://localhost:3000/openapi.json -o src/client
```

`openapi-fetch` keeps calls in the shape of HTTP; an SDK hides them
behind functions. Which to use is a matter of taste.

## Where the client lives

The client belongs to its consumers: the frontend's repository, or a
package of its own in a monorepo. The server only hands over the document,
either served, as above, or written to a file and committed. A committed
file makes every API change a visible diff and allows the CI check below.

`openapi()` builds the document without serving it. The script imports the
application, not `main.ts`, so nothing starts listening:

```ts twoslash title="scripts/openapi.ts"
// @filename: src/app.ts
import { createApp } from "@tetsujs/core";
export const app = createApp({ routes: [] });
// @filename: scripts/openapi.ts
// ---cut---
import { openapi } from "@tetsujs/openapi";
import { app } from "../src/app";

const { document, warnings } = openapi(app, { info: { title: "Users API", version: "1.0.0" } });

for (const warning of warnings) console.error(`${warning.route}: ${warning.message}`);

if (warnings.length > 0) process.exit(1);

await Bun.write("openapi.json", `${JSON.stringify(document, null, 2)}\n`);
```

A warning means part of a route could not be described, most often a
schema from a validator that emits no JSON Schema. The script fails rather
than write an incomplete document. Keeping the application apart from
`main.ts` is the layout
[Structuring an application](/docs/guides/structuring/) describes.

## Checking the document in CI

With the document committed, CI regenerates it and fails when it differs
from the committed file:

```bash
bun scripts/openapi.ts
git diff --exit-code openapi.json
```

A pull request that changes the API without updating the document fails,
and one that updates it shows the contract change next to the code. A tool
such as `oasdiff` can list which changes break existing clients.

To check the other direction, that real responses match the document, use
[`assertDescribed`](/docs/packages/openapi/#testing-against-the-document)
in tests.
