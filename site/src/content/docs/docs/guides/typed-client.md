---
title: Typed client
description: Call a Tetsu API from a frontend with typed paths, bodies and errors — with @tetsujs/client and a generated contract, in Next.js and SvelteKit with TanStack Query, or from the OpenAPI document.
sidebar:
  order: 11
---

This guide gives a frontend or another service a client with typed paths,
bodies and errors.

## Choosing

- **[`@tetsujs/client`](/docs/packages/client/)**, for your own frontends
  in TypeScript. Its types are the ones your handlers see, taken from the
  compiler.
- **[The OpenAPI document](#from-the-openapi-document)**, for other
  languages, other teams and public APIs.

## The contract

A frontend does not import the server's code. It imports a contract: a
`.d.ts` file of plain types that `tetsu-client contract` generates from the
application. Add a script to the server:

```json title="package.json"
"contract": "tetsu-client contract src/app.ts --out ../web/src/api.contract.d.ts"
```

The frontend creates its client with it:

```ts twoslash
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import { createApp } from "@tetsujs/core";
declare const app: ReturnType<typeof createApp>;
export interface Api extends ContractOf<typeof app> {}
// @filename: api.ts
// ---cut---
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

export const api = createClient<Api>({ baseUrl: "https://api.example.com" });
```

Commit the contract, so every API change shows up as a diff, and check it
in CI:

```bash
bunx tetsu-client contract src/app.ts --out ../web/src/api.contract.d.ts --check
```

In a monorepo, run the same command with `--watch` while you work, and the
frontend sees a new route as soon as it is saved. Importing `typeof app`
into the frontend also works, but it makes the frontend compile the
server's code with Bun's types; keep that for tests and Bun projects.

## TanStack Query

`@tetsujs/client/tanstack` turns the client into
[TanStack Query](https://tanstack.com/query) options:

```ts twoslash
// @filename: app.ts
import { createApp, httpError, route } from "@tetsujs/core";
import { z } from "zod";
const User = z.object({ id: z.number(), name: z.string() });
const UserNotFound = z.object({ status: z.literal(404), message: z.string(), error: z.literal("USER_NOT_FOUND") });
export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }), response: { 200: User, 404: UserNotFound } },
      handler: (ctx) => {
        if (ctx.params.id !== 1) throw httpError(404, "USER_NOT_FOUND");
        return { id: 1, name: "Ada" };
      },
    }),
  ],
});
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import type { app } from "./app";
export interface Api extends ContractOf<typeof app> {}
// @filename: api.ts
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";
export const api = createClient<Api>();
// @filename: hooks.ts
declare const id: number;
// ---cut---
import { useQuery } from "@tanstack/react-query";
import { queryUtils } from "@tetsujs/client/tanstack";
import { api } from "./api";

const q = queryUtils(api);

const user = useQuery(q.get("/users/:id").queryOptions({ params: { id } }));

if (user.error?.status === 404) {
  console.log(user.error.body.error);
  //                          ^?
}
```

The same options work with Svelte, Vue and Solid; those adapters take a
function that returns them, such as
`createQuery(() => q.get(…).queryOptions(…))`. A mutation is
`useMutation(q.post("/users").mutationOptions())`, and
`invalidateQueries({ queryKey: q.get("/users").key() })` refreshes every
query of a route.

Two things are worth setting once. Send authorization from the client, not
from each call: a call's headers are part of its query key, and would end
up in the cache. And retry only server errors, since TanStack Query retries
everything three times by default:

```ts twoslash
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import { createApp } from "@tetsujs/core";
declare const app: ReturnType<typeof createApp>;
export interface Api extends ContractOf<typeof app> {}
// @filename: setup.ts
import type { Api } from "./api.contract";
declare function currentToken(): string;
// ---cut---
import { QueryClient } from "@tanstack/react-query";
import { type ClientError, createClient } from "@tetsujs/client";

export const api = createClient<Api, { headers: "authorization" }>({
  headers: () => ({ authorization: `Bearer ${currentToken()}` }),
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => (error as ClientError).status >= 500 && count < 3 },
  },
});
```

## Next.js

On the server, a component renders for a request whose cookies the client
has to pass on itself. A client is cheap to create, so make one per
request:

```ts twoslash title="src/api.ts"
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import { createApp } from "@tetsujs/core";
declare const app: ReturnType<typeof createApp>;
export interface Api extends ContractOf<typeof app> {}
// @filename: api.ts
// ---cut---
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

export function api(cookie?: string) {
  return createClient<Api>({
    baseUrl: process.env.NEXT_PUBLIC_API_URL,
    headers: cookie === undefined ? undefined : { cookie },
  });
}
```

A server component prefetches the query and hands the cache to the browser:

```tsx twoslash title="app/users/[id]/page.tsx"
// @jsx: react-jsx
// @filename: next.d.ts
declare module "next/headers" {
  export function cookies(): Promise<{ toString(): string }>;
}
// @filename: app.ts
import { createApp, route } from "@tetsujs/core";
import { z } from "zod";
const User = z.object({ id: z.number(), name: z.string() });
export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }), response: User },
      handler: () => ({ id: 1, name: "Ada" }),
    }),
  ],
});
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import type { app } from "./app";
export interface Api extends ContractOf<typeof app> {}
// @filename: api.ts
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";
export function api(cookie?: string) {
  return createClient<Api>({ headers: cookie === undefined ? undefined : { cookie } });
}
// @filename: user.d.ts
export declare function User(props: { id: number }): null;
// @filename: page.tsx
// ---cut---
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { queryUtils } from "@tetsujs/client/tanstack";
import { cookies } from "next/headers";
import { api } from "./api";
import { User } from "./user";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const q = queryUtils(api((await cookies()).toString()));
  const queryClient = new QueryClient();

  // A failure is left to the browser, which fetches again and shows it.
  await queryClient.query(q.get("/users/:id").queryOptions({ params: { id } })).catch(() => undefined);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <User id={id} />
    </HydrationBoundary>
  );
}
```

`User` is a client component that calls `useQuery` with the same options,
over `queryUtils(api())`: in the browser, the browser sends the cookies.
For an API on another origin, pass `init: { credentials: "include" }` to
the client. In a monorepo on Bun, set `"types": ["node"]` in the Next.js
`tsconfig.json`, or it picks up Bun's types from the root.

## SvelteKit

A `load` function gets SvelteKit's `fetch`, which carries the request's
cookies on the server. Pass it to the client:

```ts twoslash title="src/lib/api.ts"
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import { createApp } from "@tetsujs/core";
declare const app: ReturnType<typeof createApp>;
export interface Api extends ContractOf<typeof app> {}
// @filename: api.ts
// ---cut---
import { createClient } from "@tetsujs/client";
import type { Api } from "./api.contract";

export function api(fetch = globalThis.fetch) {
  return createClient<Api>({ baseUrl: "https://api.example.com", fetch });
}
```

With TanStack Query, the root layout creates the query client, with queries
off on the server, where `load` functions prefetch instead:

```ts twoslash title="src/routes/+layout.ts"
// @filename: env.d.ts
declare module "$app/env" {
  export const browser: boolean;
}
// @filename: $types.d.ts
export type LayoutLoad = () => unknown;
// @filename: layout.ts
// ---cut---
import { QueryClient } from "@tanstack/svelte-query";
import { browser } from "$app/env";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = () => ({
  queryClient: new QueryClient({ defaultOptions: { queries: { enabled: browser } } }),
});
```

```ts twoslash title="src/routes/users/[id]/+page.ts"
// @filename: $types.d.ts
import type { QueryClient } from "@tanstack/svelte-query";
export type PageLoad = (event: {
  fetch: typeof fetch;
  params: { id: string };
  parent(): Promise<{ queryClient: QueryClient }>;
}) => unknown;
// @filename: app.ts
import { createApp, route } from "@tetsujs/core";
import { z } from "zod";
const User = z.object({ id: z.number(), name: z.string() });
export const app = createApp({
  routes: [
    route({
      method: "GET",
      path: "/users/:id",
      schema: { params: z.object({ id: z.coerce.number() }), response: User },
      handler: () => ({ id: 1, name: "Ada" }),
    }),
  ],
});
// @filename: api.contract.d.ts
import type { ContractOf } from "@tetsujs/client";
import type { app } from "./app";
export interface Api extends ContractOf<typeof app> {}
// @filename: lib.d.ts
declare module "#lib/api.ts" {
  import type { Client } from "@tetsujs/client";
  import type { Api } from "./api.contract";
  export function api(fetch?: typeof globalThis.fetch): Client<Api>;
}
// @filename: page.ts
// ---cut---
import { queryUtils } from "@tetsujs/client/tanstack";
import { api } from "#lib/api.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, params, parent }) => {
  const { queryClient } = await parent();
  const id = Number(params.id);
  const q = queryUtils(api(fetch));

  await queryClient.query(q.get("/users/:id").queryOptions({ params: { id } })).catch(() => undefined);

  return { id };
};
```

The page calls `createQuery(() => q.get("/users/:id").queryOptions({ params: { id: data.id } }))`
over `queryUtils(api())` and finds the user in the cache. Wrap the layout
in `QueryClientProvider` with `data.queryClient`, as the
[Svelte Query docs](https://tanstack.com/query/latest/docs/framework/svelte/ssr)
show.

Nuxt, SolidStart and other frameworks follow the same idea: a client per
request that passes its cookies on, and prefetching as TanStack Query's
guide for that framework describes.

## From the OpenAPI document

[`@tetsujs/openapi`](/docs/packages/openapi/) serves the document at
`/openapi.json`. [`openapi-typescript`](https://openapi-ts.dev) turns it
into types:

```bash
bunx openapi-typescript http://localhost:3000/openapi.json -o src/openapi.d.ts
```

and [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) calls the API
with them:

```ts twoslash
// @filename: openapi.d.ts
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
import type { paths } from "./openapi";

const api = createClient<paths>({ baseUrl: "https://api.example.com" });

const { data, error } = await api.GET("/users/{id}", { params: { path: { id: 42 } } });

if (error) {
  console.log(error.error);
  //                ^?
} else {
  console.log(data.name);
}
```

`error` is the body of any other status the document lists, including the
`422` and `500` the framework answers. Branch on its `error` code. A
refusal from a hook is in the document only when the hook is
[documented](/docs/packages/openapi/#documenting-hooks). To commit the
document and check it in CI, as with the contract, see
[Using the document directly](/docs/packages/openapi/#using-the-document-directly).
