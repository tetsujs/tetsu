---
title: Routes and handlers
description: How a route is declared with route(), which paths the compiler accepts, what a handler returns and how routes reach Bun's router.
sidebar:
  order: 1
---

A route is one method on one path, and the handler that answers it. This
page covers what `route()` takes, the paths it accepts, what a handler may
return, and how the routes you declare end up in Bun's router.

## Declaring a route

`route()` takes a configuration object and returns it, branded, so that the
application can find it among the fields of a controller. Nothing is
registered anywhere when it is called: a route is data until `createApp()`
reads it.

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

`ctx` is never annotated. Everything on it — the path parameters, the
validated parts, what hooks contributed — is inferred at the `route()` call
from the rest of the configuration. The fields are:

| Field | Required | |
| --- | --- | --- |
| `method` | yes | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | yes | the path, with `:param` segments, checked at compile time |
| `handler` | yes | the function that answers the request |
| `schema` | no | schemas for `params`, `query`, `headers`, `cookies`, `body` and `response` — see [Validation](/docs/concepts/validation/) |
| `hooks` | no | hooks keyed by slot — see [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) |
| `bodyType` | no | `"json"`, `"form"`, `"text"` or `"stream"` — see [Request bodies](/docs/concepts/request-bodies/) |
| `maxBodySize` | no | this route's body limit in bytes, in place of the application's |
| `rawBody` | no | keep the body's bytes next to the parsed body, for signatures |
| `docs` | no | `summary`, `description`, `tags`, `deprecated`, `hidden`, `operationId` — read by [`@tetsujs/openapi`](/docs/packages/openapi/) only |

The [route reference](/docs/reference/route/) lists them with their types.

## Methods

A route declares one of `GET`, `POST`, `PUT`, `PATCH` and `DELETE`. `HEAD`
and `OPTIONS` are not on the list because every path answers them itself:
`HEAD` runs the path's `GET` route and Bun sends its headers without the
body, and `OPTIONS` answers `204` with an `Allow` header listing the
path's methods. Any other method on a known path is a `405` carrying the
same `Allow`.

The method is checked at runtime too, for code the compiler did not see: a
lower-case `"get"` or a `"HEAD"` route is refused when `route()` runs.

## Paths

A path starts with `/`, has no empty segments and no trailing slash. A
segment that starts with `:` is a parameter, and it spans the whole
segment. A `*` is allowed only as the whole last segment, where it matches
the rest of the path:

```ts twoslash
import { route } from "@tetsujs/core";

route({ method: "GET", path: "/users/:userId/notes/:noteId", handler: () => undefined });
route({ method: "GET", path: "/files/*", handler: () => undefined });
```

These are the rules Bun's router follows, and the framework checks them at
compile time so that a path it would never match does not compile. The
syntax that most often looks right and is not — `{id}`, as OpenAPI and
several other frameworks spell a parameter, and `:id?`, an optional
parameter Bun's router does not have — is refused rather than matched
literally:

```ts twoslash
import { route } from "@tetsujs/core";
// ---cut---
// @errors: 2322
route({ method: "GET", path: "/users/{id}", handler: () => undefined });
route({ method: "GET", path: "/users/:id?", handler: () => undefined });
```

The same check refuses a bare `:`, a parameter that shares its segment with
something else (`/a/:b-:c`, `/a/b:c`), and a `*` anywhere but the end
(`/a/*/b`, `/files/*rest`). Each error names the rule it broke. A path the
compiler never saw as a literal — built from a variable, or declared from
JavaScript — is checked by the same rules when `route()` runs, so it fails
at startup with the same message.

Two more mistakes can only be seen once the whole application is known,
and `createApp()` refuses both at startup: the same method and path
declared twice, and two paths that differ only in the names of their
parameters, such as `/users/:id` and `/users/:userId`. Bun's router sees
one pattern there, and the later route would silently shadow the earlier.

A `*` matches, but it captures nothing: Bun puts no parameter in
`ctx.params` for it. A route that needs the rest of the path reads it from
`ctx.req.url`.

## Parameters from the path

Path parameters are typed from the path literal. Each `:name` becomes a
field of `ctx.params`, and a path without parameters has an empty
`ctx.params`:

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

They are strings, because that is what a URL holds. A `params` schema
narrows them further — to a number, a UUID, an enum — and is the only way
to do so; see [Validation](/docs/concepts/validation/). A route's type knows
only its own path: a group's prefix cannot declare parameters, since the
controller is typed where it is written and not where it is mounted.

## What a handler returns

The value a handler returns becomes the response:

- a value is serialized as JSON with status `200`;
- `undefined` — or a handler that ends without `return` — is `204` with no
  body;
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

A status and headers for a serialized result are set on `ctx.out`; a
`Response` states its own. A `ReadableStream`, an async iterable or a
generator returned bare is a compile error: each would serialize to `{}`
and the body would be lost without a word. A stream goes inside a
`Response` — see [Streaming](/docs/concepts/streaming/).

A route that declares a `response` schema narrows what the handler may
return and which statuses it may set; [Responses](/docs/concepts/responses/)
covers response maps, redirects and headers, and
[Errors](/docs/concepts/errors/) covers what a thrown error becomes.

Handlers can be `async`, and a handler that is not costs nothing for it:
the request runs synchronously until something along the way returns a
promise.

## The matched route

`ctx.route` is the route that matched, as it was declared. Its `path` is
the template with group prefixes joined — never the URL — which is what a
log line or a metric should be labelled with, since a label built from the
URL grows one series per identifier:

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

`controller` is the name given to `controller()`, and `name` is the field
the route was declared under — the same two that
[`@tetsujs/openapi`](/docs/packages/openapi/) builds an `operationId` from.
Both are absent for a route mounted on its own, outside a controller.
Hooks that also run for a `404`, a `405` or a preflight see `ctx.route` as
optional, because nothing matched there.

## How routes reach Bun's router

`createApp()` returns plain data, and `Bun.serve` takes it as it is:

```ts twoslash
declare const notesController: () => object;
// ---cut---
import { createApp } from "@tetsujs/core";

const app = createApp({ routes: notesController() });

Bun.serve({ ...app, port: 3000 });
```

Routing is Bun's, entirely. Every declared path becomes one entry of the
`routes` object `Bun.serve` receives, and its value is one function that
serves every method of that path. Bun's native router decides which path a
URL belongs to, decodes it and extracts the parameters; the function then
looks up the method in a table built for that exact path at startup, which
needs no matching at all. The declared method runs its route, `HEAD` runs
the `GET` route, `OPTIONS` answers from the path's `Allow` set, and
anything else is a `405`.

`app.fetch` is only the fallback: Bun calls it when no path matched, so it
is the `404` — or the `fallback` option of `createApp`, for a single-page
application's index. Calling `app.fetch` directly does not route; every
request it receives takes the fallback. That is why integration tests go
through a real server, which `serve()` from `@tetsujs/core/testing` starts
on a free port — see [Testing](/docs/guides/testing/).

There is no second matcher kept in step with Bun's. One router means a test
cannot pass against one matcher while production serves another, and
precedence between overlapping paths — a static segment over a parameter,
a parameter over `*` — is whatever Bun's router says it is.
