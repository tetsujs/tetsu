---
title: Writing a hook package
description: How to write a reusable hook — one function from options to one hook, typed by inference, refusing with HttpError, documented in OpenAPI and tested over HTTP.
sidebar:
  order: 12
---

This guide writes a reusable hook the way the framework's own packages are
written, using an API-key check as the example: the package's shape, the
rules that keep its types and failures honest, and a test.

## A package is one hook

Tetsu has no plugin system. A package is a function that takes options and
returns one hook, which the application mounts like any hook of its own —
`cors()`, `requestId()` and `rateLimit()` all have this shape. The
compiler checks the package's hook as it checks any other: its slot, what
it needs from the context and what it adds.

The function runs once, where the application is wired, and reads and
checks the options. The hook it returns runs for every request.

A package that seems to need two slots usually does not: `accessLog()`
reads the start time from `ctx.startedAt` instead of a `beforeParse` hook,
and `cors()` sets its headers on `ctx.out` instead of a late hook. If yours
still needs two, [open an issue](https://github.com/tetsujs/tetsu/issues).

## An API-key check

The hook reads a key from a header, looks it up, refuses the request when
the key is unknown, and adds the key's client to the context:

```ts twoslash
import { hook, httpError, reportFailure } from "@tetsujs/core";
import { secured } from "@tetsujs/openapi";

export interface ApiClient {
  readonly id: string;
  readonly name: string;
}

export interface ApiKeyStore {
  find(keyHash: string): ApiClient | undefined | Promise<ApiClient | undefined>;
  used?(clientId: string, at: Date): Promise<void>;
}

export interface ApiKeyOptions {
  readonly store: ApiKeyStore;
  readonly header?: string;
}

export function apiKey(options: ApiKeyOptions) {
  const header = options.header ?? "x-api-key";

  const check = hook.beforeParse(async (ctx) => {
    const key = ctx.req.headers.get(header);
    const client = key ? await options.store.find(hashOf(key)) : undefined;

    if (!client) throw httpError(401, "INVALID_API_KEY", "A valid API key is required");

    void options.store.used?.(client.id, new Date()).catch((error) => {
      reportFailure(ctx, "apiKey", error);
    });

    return { client };
  });

  return secured(check, {
    name: "apiKey",
    scheme: { type: "apiKey", in: "header", name: header },
    error: "INVALID_API_KEY",
    description: "The API key is missing or unknown",
  });
}

export type ApiKeyHook = ReturnType<typeof apiKey>;

function hashOf(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}
```

Mounted on a route, it gives the handler a typed `ctx.client`:

```ts twoslash
import { hook, httpError } from "@tetsujs/core";
interface ApiClient { readonly id: string; readonly name: string }
declare const clients: Map<string, ApiClient>;
function apiKey(_: { store: { find(hash: string): ApiClient | undefined } }) {
  return hook.beforeParse((ctx) => {
    const client = clients.get(ctx.req.headers.get("x-api-key") ?? "");
    if (!client) throw httpError(401, "INVALID_API_KEY");
    return { client };
  });
}
// ---cut---
import { controller, route } from "@tetsujs/core";

const guard = apiKey({ store: { find: (hash) => clients.get(hash) } });

const reportsController = controller("Reports", () => ({
  list: route({
    method: "GET",
    path: "/reports",
    hooks: { beforeParse: [guard] },
    handler: (ctx) => ({ requestedBy: ctx.client.name }),
    //                                      ^?
  }),
}));
```

The sections below explain each part.

## Do not annotate the return type

`apiKey` has no return type on purpose. The hook's type carries its slot,
the context it needs and the context it adds, all inferred from the
`hook.beforeParse` call. An annotation such as `AnyHook` erases them, and
even a precise slot loses what the hook adds:

```ts twoslash
// @errors: 2339
import type { BaseCtx, Hook } from "@tetsujs/core";
import { hook, httpError, route } from "@tetsujs/core";

function apiKey(): Hook<"beforeParse", BaseCtx, unknown> {
  return hook.beforeParse((ctx) => {
    if (!ctx.req.headers.has("x-api-key")) throw httpError(401, "INVALID_API_KEY");

    return { client: { id: "c1", name: "Reports" } };
  });
}

route({
  method: "GET",
  path: "/reports",
  hooks: { beforeParse: [apiKey()] },
  handler: (ctx) => ctx.client.name,
});
```

To give the type a public name, read it off the function:
`export type ApiKeyHook = ReturnType<typeof apiKey>`.

The one exception is a package whose slot is chosen by an option, as
`rateLimit()`'s `slot` is. It writes one overload per slot, each returning
that slot's precise hook. See
[the rate limiter's source](https://github.com/tetsujs/tetsu/blob/main/packages/rate-limit/src/index.ts).

## Refuse by throwing, set headers on `ctx.out`

A refusal is a thrown `HttpError` made with `httpError(status, code,
message)`, never a `Response` the hook builds. A thrown error goes through
the application's `onError` hooks, so an application with its own error
format formats the package's refusal too. Name the code, such as
`INVALID_API_KEY`, after what happened; it is what clients branch on. See
[Errors](/docs/concepts/errors/).

A header the package adds goes on `ctx.out.headers`. The core puts those
on every response that leaves — the handler's, an error, a `404` — so a
header set before a refusal is on the refusal too. A maintenance switch
shows both rules, and how to document a refusal that carries a header:

```ts twoslash
import { hook, httpError } from "@tetsujs/core";
import { documented } from "@tetsujs/openapi";

export function maintenance(options: { readonly until: () => Date | undefined }) {
  const check = hook.beforeParse((ctx) => {
    const end = options.until();

    if (!end) return;

    ctx.out.headers.set("retry-after", String(Math.max(1, Math.ceil((end.getTime() - Date.now()) / 1000))));

    throw httpError(503, "MAINTENANCE", "Down for maintenance");
  });

  return documented(check, {
    responses: [
      {
        status: 503,
        description: "The API is down for maintenance",
        error: "MAINTENANCE",
        headers: { "retry-after": { schema: { type: "integer", minimum: 1 } } },
      },
    ],
  });
}
```

## Contribute to the document

A hook that answers by itself — a `401`, a `429`, a `503` — changes what
the routes it guards can answer. The package annotates its hook with
`@tetsujs/openapi` so the [OpenAPI document](/docs/packages/openapi/) says
so on every route it runs for:

- **`secured(hook, requirement)`** adds a security scheme and its refusal,
  `401` unless the requirement sets `status`.
- **`documented(hook, { responses })`** adds responses: a status, its
  `error` code, and the fields and headers the hook adds.

Both return a copy of the hook with the same type, so the annotated hook
mounts exactly like the plain one. See
[Documenting hooks](/docs/packages/openapi/#documenting-hooks).

## State lives in the instance

Anything the hook keeps between requests belongs to the instance
`apiKey()` returned: two calls make two independent hooks. Keep nothing in
module scope, where every application and every test in the process would
share it.

State shared across processes — counters, locks, the keys themselves —
goes behind an interface the application implements, as `ApiKeyStore`
does here and `RateLimitStore` does for
[`@tetsujs/rate-limit`](/docs/packages/rate-limit/#a-shared-store). Keep
the interface to the methods the hook calls, and let a method return a
value or a promise, so an in-memory test store can stay synchronous.

The store is given the key's hash, not the key, so a database dump holds no
working keys.

## Report what cannot be answered

Recording when a key was last used should not make the request wait, so
the hook starts the write and does not await it. If the write fails, the
response may already be gone, and there is nobody to answer with an error.
`reportFailure(ctx, source, error)` hands the failure to the
application's `reportError` with the request's context, so the report
carries the request id. `source` names the package.

A failure the hook can answer is thrown instead: a store that throws in
`find` becomes a `500` and is reported like any unhandled error.

## No timers without an owner

A package does not start an interval or a timeout that outlives the
request: the timer keeps the process alive, nobody can stop it, and tests
hang. To expire entries, sweep as the hook is used, the way the rate
limiter's memory store drops old windows as its map grows. For work in the
background, take a signal from the application as an option, such as the
`stopping` signal of [`@tetsujs/lifecycle`](/docs/packages/lifecycle/).

## Testing

Test a package the way you test an application: mount it on a small
application, serve it with `serve()`, and send it requests. The same test
can check that the document describes the refusal the hook really sends:

```ts twoslash
// @filename: api-key.ts
import { hook, httpError, reportFailure } from "@tetsujs/core";
import { secured } from "@tetsujs/openapi";
export interface ApiClient { readonly id: string; readonly name: string }
export interface ApiKeyStore {
  find(keyHash: string): ApiClient | undefined | Promise<ApiClient | undefined>;
  used?(clientId: string, at: Date): Promise<void>;
}
export function apiKey(options: { readonly store: ApiKeyStore; readonly header?: string }) {
  const header = options.header ?? "x-api-key";
  const check = hook.beforeParse(async (ctx) => {
    const key = ctx.req.headers.get(header);
    const client = key ? await options.store.find(new Bun.CryptoHasher("sha256").update(key).digest("hex")) : undefined;
    if (!client) throw httpError(401, "INVALID_API_KEY", "A valid API key is required");
    void options.store.used?.(client.id, new Date()).catch((error) => {
      reportFailure(ctx, "apiKey", error);
    });
    return { client };
  });
  return secured(check, {
    name: "apiKey",
    scheme: { type: "apiKey", in: "header", name: header },
    error: "INVALID_API_KEY",
    description: "The API key is missing or unknown",
  });
}
// @filename: api-key.test.ts
// ---cut---
import { expect, test } from "bun:test";
import { controller, createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
import { openapi } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";
import { apiKey } from "./api-key";

const hashOf = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");
const clients = new Map([[hashOf("key-1"), { id: "c1", name: "Reports" }]]);
const guard = apiKey({ store: { find: (hash) => clients.get(hash) } });

const reports = controller("Reports", () => ({
  list: route({
    method: "GET",
    path: "/reports",
    hooks: { beforeParse: [guard] },
    handler: (ctx) => ({ requestedBy: ctx.client.name }),
  }),
}));

const app = createApp({ routes: reports() });
const request = serve(app);
const { document } = openapi(app, { info: { title: "Test", version: "1" } });

test("a known key passes, with its client", async () => {
  const res = await request("/reports", { headers: { "x-api-key": "key-1" } });

  expect(await res.json()).toEqual({ requestedBy: "Reports" });
});

test("an unknown key is refused as the document says", async () => {
  const res = await request("/reports", { headers: { "x-api-key": "key-2" } });

  expect(res.status).toBe(401);
  await assertDescribed(document, "GET /reports", res);
});

test("the route is documented as requiring a key", () => {
  expect(document.paths["/reports"]?.get?.security).toEqual([{ apiKey: [] }]);
});
```

The store is a `Map` in the test. To test the failure report, pass a
store whose `used` rejects and a `reportError` that collects what it
receives. More on testing is in [Testing](/docs/guides/testing/).

## Publishing

- **`@tetsujs/core` is a peer dependency.** The application and the
  package must share one copy of the core: an `HttpError` from a second
  copy is not an instance of the application's, and the refusal would
  become a `500`.
- **`@tetsujs/openapi` is a dependency** when the package annotates its
  hook, as in `@tetsujs/rate-limit`.
- **Export the options and the hook's type** — `ApiKeyOptions`,
  `ApiKeyHook` — so an application can pass the hook around.
- **Say which slot it goes in**, and where in that slot: before or after
  `cors()`, after the hooks that provide what it `Requires`. The compiler
  checks what a hook needs, not what should come first. See
  [Groups and mounting](/docs/concepts/groups-and-mounting/).
