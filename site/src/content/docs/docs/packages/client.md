---
title: "@tetsujs/client"
description: A typed fetch client for a Tetsu application, typed by a contract generated from its routes, with TanStack Query options.
sidebar:
  order: 3
  label: "@tetsujs/client"
---

`@tetsujs/client` calls a Tetsu application with the types its routes
already declare. It is a small `fetch` wrapper with no dependencies. A
frontend gets the types from a contract, a `.d.ts` file generated from the
application. Setting it up in Next.js or SvelteKit is in the
[guide](/docs/guides/typed-client/).

```bash
bun add @tetsujs/client
```

## Usage

```ts twoslash
// @filename: app.ts
import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const User = z.object({ id: z.number(), name: z.string(), createdAt: z.date() });
const UserNotFound = z.object({ status: z.literal(404), message: z.string(), error: z.literal("USER_NOT_FOUND") });

export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }), response: { 200: User, 404: UserNotFound } },
      handler: (ctx) => {
        if (ctx.params.id !== 1) throw httpError(404, "USER_NOT_FOUND");

        return { id: 1, name: "Ada", createdAt: new Date() };
      },
    }),
  ],
});
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import type { app } from "./app";
export interface Api extends ContractOf<typeof app> {}
// @filename: client.ts
// ---cut---
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

const api = createClient<Api>({ baseUrl: "https://api.example.com" });

const res = await api.get("/users/:id", { params: { id: 42 } });

if (res.ok) {
  console.log(res.data.createdAt);
  //                   ^?
} else {
  console.log(res.status);
}
```

`api.get` suggests the paths that answer `GET`. A wrong path, a missing
parameter or a wrong body is a compile error. `data` is what JSON
delivers, so a `Date` is a string.

`Api` comes from the [contract](#the-contract). In tests and projects on
Bun, which have Bun's types anyway, `createClient<typeof app>()` reads the
application's type directly.

## A call

A call takes the path, then the parts the route declares:

| Option | |
| --- | --- |
| `params` | the path's `:name` segments |
| `query` | the query string; an array repeats its key |
| `body` | the body: an object goes as JSON |
| `form` | the body of a route with `bodyType: "form"`, sent as `FormData` |
| `headers` | the headers the route declares, and any other |
| `init` | the rest of `RequestInit`: `signal`, `credentials`… |

Parameters, the query and headers travel as text; a `Date` goes as its ISO
string. A part the route does not declare is a compile error.
`api.url(path, { params, query })` returns the address without sending,
for an image or an `EventSource`.

## The result

A call does not throw on an error status. It resolves to one member per
status the route declares, told apart by `ok` and `status`:

```ts twoslash
// @filename: app.ts
import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";
const UserNotFound = z.object({ status: z.literal(404), message: z.string(), error: z.literal("USER_NOT_FOUND") });
export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }), response: { 200: z.object({ name: z.string() }), 404: UserNotFound } },
      handler: (ctx) => {
        if (ctx.params.id !== 1) throw httpError(404, "USER_NOT_FOUND");
        return { name: "Ada" };
      },
    }),
  ],
});
// @filename: client.ts
import { createClient } from "@tetsujs/client";
import type { app } from "./app";
const api = createClient<typeof app>();
const res = await api.get("/users/:id", { params: { id: 42 } });
// ---cut---
if (res.status === 404) {
  console.log(res.error.error);
  //                    ^?
}
```

A status the route does not declare comes with the core's
[error envelope](/docs/concepts/errors/#the-envelope). Only what is not a
response throws: a network failure, an aborted request, JSON that does not
parse.

`unwrap()` returns the data, or throws a `ClientError` with `status`,
`body` and `response`:

```ts twoslash
import { createClient, unwrap } from "@tetsujs/client";
const api = createClient();
const id = 1;
// ---cut---
const user = unwrap(await api.get("/users/:id", { params: { id } }));
```

## Options

| Option | Default | |
| --- | --- | --- |
| `baseUrl` | `""` | put before every path |
| `headers` | none | sent with every request; a function is called for each one |
| `fetch` | the global `fetch` | what sends the request: SvelteKit's `event.fetch`, a test client, a wrapper |

A client is a plain object, cheap enough to create one per request.

A second type argument names the headers the client sends itself, so a
route that requires one does not require it of each call:

```ts twoslash
// @filename: app.ts
import { createApp } from "@tetsujs/core";
export const app = createApp({ routes: [] });
// @filename: client.ts
import type { app } from "./app";
declare const token: string;
// ---cut---
import { createClient } from "@tetsujs/client";

const api = createClient<typeof app, { headers: "authorization" }>({
  headers: () => ({ authorization: `Bearer ${token}` }),
});
```

For an application with [its own error format](/docs/concepts/errors/#an-error-format-of-your-own),
add `error: AppError` next to `headers`.

In tests, the core's [test client](/docs/guides/testing/#a-client-with-a-session)
is a `fetch` with a cookie jar: `createClient<typeof app>({ fetch: request.client() })`.

## The contract

`tetsu-client contract` writes the contract of the application a module
exports:

```bash
bunx tetsu-client contract src/app.ts --out ../web/src/api.contract.d.ts
```

| Option | |
| --- | --- |
| `--out <path>` | where to write; printed without it |
| `--export <name>` | the export with the application, or a function that builds it; `app` by default |
| `--check` | write nothing, fail when the file is out of date |
| `--watch` | write again whenever the application changes |

`--name` and `--tsconfig` change the interface's name and the
`tsconfig.json` used. The contract holds plain types only: no server code,
no validators, no Bun. A brand is dropped and an `enum` becomes a union of
its values. A type it cannot hold, such as a function, is an error that
says where.

The command runs on Bun. On first run, Bun downloads TypeScript 6.0.3 into
its own cache to work the types out. `generateContract()` from
`@tetsujs/client/contract` does the same from a script.

## TanStack Query

`@tetsujs/client/tanstack` turns a client into
[TanStack Query](https://tanstack.com/query) options for any adapter:

```ts twoslash
import { createClient } from "@tetsujs/client";
const api = createClient();
// ---cut---
import { queryUtils } from "@tetsujs/client/tanstack";

const q = queryUtils(api);
```

| | |
| --- | --- |
| `q.get(path).queryOptions(call)` | a query |
| `q.get(path).infiniteOptions({ input, … })` | an infinite query; `input` turns a page param into the call |
| `q.post(path).mutationOptions()` | a mutation; its variables are the call |
| `q.get(path).key()` | the start of the route's keys, for `invalidateQueries` |

A query's error is a `ClientError`: `error.status === 404` narrows
`error.body` to that status's body. Its key is
`[method, path, call]`, typed, so `getQueryData` knows what it holds. The
types need `@tanstack/query-core`, which every adapter installs. Usage is
in the [guide](/docs/guides/typed-client/#tanstack-query).

## What the types don't know

- A declared `404` or `422` also covers the router's `404` and the
  validation `422`.
- `fetch` follows redirects, so a `3xx` arrives as the target's response.
- A string body goes as text: for a JSON route that takes a string, send
  `JSON.stringify(text)`.
- A route with only `rawBody: true` takes no body from the client: give it
  a `bodyType`.
- A query array of one item reaches the server as a string; see
  [Converting strings](/docs/concepts/validation/#converting-strings).
- `const { get } = api` loses the types: call `api.get()`.
- An undeclared `5xx` from a proxy may have no body, so its `error` can be
  `undefined`.
- In TanStack Query, a network failure is a `TypeError`, not a
  `ClientError`; `error?.status` is safe either way.
- With pnpm, keep one version of `@tanstack/query-core`, or the keys lose
  their types.
- On TypeScript 5.7, type the client with an interface:
  `interface Api extends ContractOf<typeof app> {}`.
