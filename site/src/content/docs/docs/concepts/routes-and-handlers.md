---
title: Routes and handlers
description: Declaring a route with route(), what a handler returns, and the paths the compiler accepts.
sidebar:
  order: 1
---

A route is one method on one path, and the handler that answers it.

## Declaring a route

`route()` takes a configuration object and returns it as data. Nothing is
registered when it runs; `createApp()` reads the routes later.

```ts twoslash
import { controller, route } from "@tetsujs/core";

export const notesController = controller("Notes", () => ({
  get: route({
    method: "GET",
    path: "/notes/:id",
    handler: (ctx) => ({ id: ctx.params.id, title: "First note" }),
  }),
}));
```

Never annotate `ctx`. Its type is inferred from the rest of the
configuration: the path parameters, the validated parts, and what hooks
add. The fields are:

| Field | Required | |
| --- | --- | --- |
| `method` | yes | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | yes | the path, with `:param` segments |
| `handler` | yes | the function that answers the request |
| `schema` | no | schemas for `params`, `query`, `headers`, `cookies`, `body` and `response` — see [Validation](/docs/concepts/validation/) |
| `hooks` | no | hooks keyed by slot — see [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) |
| `bodyType` | no | `"json"`, `"form"`, `"text"` or `"stream"` — see [Request bodies](/docs/concepts/request-bodies/) |
| `maxBodySize` | no | this route's body limit in bytes, in place of the application's |
| `rawBody` | no | keep the body's bytes next to the parsed body, for signatures |
| `docs` | no | `summary`, `description`, `tags`, `deprecated`, `hidden`, `operationId` — read by [`@tetsujs/openapi`](/docs/packages/openapi/) only |

The [route reference](/docs/reference/route/) lists them with their types.

## What a handler returns

The value a handler returns becomes the response:

- a value is sent as JSON with status `200`;
- `undefined`, or no `return` at all, is `204` with no body;
- a `Response` is sent as it is.

```ts twoslash
interface Note { id: number; title: string }
declare const notes: { add(title: string): Note; remove(id: number): void };
// ---cut---
import { controller, route } from "@tetsujs/core";
import { z } from "zod";

export const notesController = controller("Notes", () => ({
  create: route({
    method: "POST",
    path: "/notes",
    schema: { body: z.object({ title: z.string().min(1) }) },
    handler: (ctx) => {
      ctx.out.status = 201;

      return notes.add(ctx.body.title);
    },
  }),

  remove: route({
    method: "DELETE",
    path: "/notes/:id",
    handler: (ctx) => {
      notes.remove(Number(ctx.params.id));
    },
  }),

  export: route({
    method: "GET",
    path: "/notes/export",
    handler: () => new Response("id,title\n", { headers: { "content-type": "text/csv" } }),
  }),
}));
```

Set the status and headers of a JSON result on `ctx.out`; a `Response`
carries its own. A handler may be `async`.
[Responses](/docs/concepts/responses/) covers response schemas, redirects
and streams, and [Errors](/docs/concepts/errors/) covers what a thrown error
becomes.

## Path parameters

Each `:name` segment becomes a field of `ctx.params`, typed from the path
literal:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
route({
  method: "GET",
  path: "/users/:userId/notes/:noteId",
  handler: (ctx) => ctx.params,
  //                    ^?
});
```

Parameters are strings. To get a number, a UUID or an enum, declare a
`params` schema; see [Validation](/docs/concepts/validation/). A path
without parameters has an empty `ctx.params`.

## Path rules

A path starts with `/` and has no empty segments and no trailing slash. A
parameter takes a whole segment. A `*` is allowed only as the whole last
segment, where it matches the rest of the path:

```ts twoslash
import { route } from "@tetsujs/core";

route({ method: "GET", path: "/users/:userId/notes/:noteId", handler: () => undefined });
route({ method: "GET", path: "/files/*", handler: () => undefined });
```

These are the rules of Bun's router, and a path that breaks them does not
compile. That includes two spellings that look right but are not: `{id}`
and the optional parameter `:id?`, which Bun's router does not support:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
// @errors: 2322
route({ method: "GET", path: "/users/{id}", handler: () => undefined });
route({ method: "GET", path: "/users/:id?", handler: () => undefined });
```

A path the compiler cannot see, such as one built from a variable, is
checked with the same rules when `route()` runs.

`createApp()` also refuses two mistakes at startup: the same method and
path declared twice, and two paths that differ only in parameter names,
such as `/users/:id` and `/users/:userId`. Bun's router treats those as
one pattern.

A `*` captures nothing: `ctx.params` has no field for it. Read the rest of
the path from `ctx.req.url`.

## Methods

A route declares `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. Every path
answers `HEAD` and `OPTIONS` on its own: `HEAD` runs the path's `GET`
route and sends the headers without the body, and `OPTIONS` answers `204`
with an `Allow` header. Any other method on a known path gets `405` with
the same `Allow`.

## The matched route

`ctx.route` describes the route that matched:

```ts twoslash
import { controller, route } from "@tetsujs/core";

export const usersController = controller("Users", () => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    handler: (ctx) => {
      ctx.route.path;       // "/users/:id"
      ctx.route.method;     // "GET"
      ctx.route.controller; // "Users"
      ctx.route.name;       // "get"

      return { id: ctx.params.id };
    },
  }),
}));
```

`path` is the template with group prefixes joined, never the URL. Use it
to label logs and metrics: a label built from the URL creates a new series
for every id. `controller` and `name` are absent for a route mounted on
its own, outside a controller. In hooks that also run for a `404`, a `405`
or a preflight, `ctx.route` is optional, because no route matched.

## How routes reach Bun's router

Routing is done by Bun's native router. `createApp()` turns each declared
path into one entry of the `routes` object `Bun.serve` takes, and that
entry picks the route by method. There is no second matcher, so the
precedence between overlapping paths is Bun's.

`app.fetch` only handles requests that matched no path: it answers `404`,
or runs the `fallback` option of `createApp`. Calling `app.fetch` directly
does not route, so integration tests go through a real server; see
[Testing](/docs/guides/testing/).
