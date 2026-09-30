---
title: Writing a hook package
description: How to write a reusable hook — one function from options to one hook, typed by inference, refusing with HttpError, documented in OpenAPI and tested over HTTP.
sidebar:
  order: 12
---

This guide writes a reusable hook the way the framework's own packages
are written: an API-key check that other applications can install and
mount. It covers the shape of a package, the rules that keep its types and
its failures honest, and a test.

## A package is one hook

Tetsu has no plugin system. A package is a function that takes options
and returns one hook, which the application mounts in its slot like any
hook of its own — `cors()`, `requestId()` and `rateLimit()` are all this
shape. Everything that runs for a route stays visible where the route
mounts it, and the compiler checks the package's hook as it checks any
other: its slot, what it needs from the context, what it adds.

The function runs once, where the application is wired, and the hook it
returns runs for every request. Options are read and checked in the
function; the request is handled in the hook.

## An API-key check

The hook reads a key from a header, looks it up, refuses the request when
the key is unknown, and adds the client it belongs to to the context:

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

The sections below go through what each part of the package does, and
why.

## Do not annotate the return type

`apiKey` has no return type written on it, and that is deliberate. The
hook's type carries three things: its slot, the context it needs and the
context it adds. All three are inferred from the `hook.beforeParse` call,
and all three are what the application's compiler checks it by.

The type that looks right — `Hook<SlotName, unknown, unknown>`, the widest
hook there is, exported as `AnyHook` — erases them. With the slot erased,
the hook could be any slot's, and a slot refuses it; with the contribution
erased, nothing it returns reaches the context. Even a precise slot does
not save the second half:

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

Give the type a public name instead, read off the function:
`export type ApiKeyHook = ReturnType<typeof apiKey>`. It stays exactly
what the function returns, whatever the function comes to return.

A package whose slot is chosen by an option — `rateLimit()` runs in
`beforeParse`, `beforeValidation` or `beforeHandle`, by its `slot` option
— is the one case for writing the return type out: one overload per slot,
each returning the precise hook of that slot, so the option decides which
one the caller gets. See
[the rate limiter's source](https://github.com/tetsujs/tetsu/blob/main/packages/rate-limit/src/index.ts).

## Refuse by throwing

A refusal is a thrown `HttpError`, made with `httpError(status, code,
message)`, never a `Response` the hook builds itself. A thrown error goes
through the application's `onError` hooks like every other failure, so an
application with an error format of its own formats the package's refusal
too, and its clients see one shape. A `Response` returned from the hook
would be sent as it is, past that format.

The code, `INVALID_API_KEY`, is the part a client branches on; name it
after what happened, in the application's upper-case style. See
[Errors](/docs/concepts/errors/).

## Headers go on `ctx.out`

A header the package adds to the response goes on `ctx.out.headers`. The
core puts those on whatever response leaves — the handler's, an error, a
`404` — so a header set before a refusal is on the refusal too. A hook that
built or cloned a `Response` to add a header would miss every response it
did not build.

A maintenance switch shows both rules, and the documentation of a refusal
that carries a header:

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
the routes it guards can answer, and their
[OpenAPI document](/docs/packages/openapi/) should say so without every
route repeating it. The core knows nothing about documents, so the
package annotates its hook with `@tetsujs/openapi`:

- **`secured(hook, requirement)`** adds a security scheme — `apiKey` in a
  header above — and the refusal that goes with it, `401` unless the
  requirement says otherwise. Every route the hook runs for is documented
  as requiring it.
- **`documented(hook, { responses })`** adds responses: a status, its
  `error` code, the fields the hook adds to the envelope and the headers
  it sets.

Both return a copy of the hook with its type unchanged, so the annotated
hook mounts exactly as the plain one would. An application that does not
generate a document pays nothing for the annotation. See
[Documenting hooks](/docs/packages/openapi/#documenting-hooks).

## State lives in the instance

Everything the hook keeps between requests belongs to the instance
`apiKey()` returned: two calls make two independent hooks, and one
instance mounted on two groups is one hook shared by both. Keep nothing in
module scope, where every application in the process — and every test —
would share it without asking.

State that has to be shared across processes — a fleet's counters, a
lock, the keys themselves — goes behind an interface the application
implements, as `ApiKeyStore` does here and `RateLimitStore` does for
[`@tetsujs/rate-limit`](/docs/packages/rate-limit/#a-shared-store). Keep
the interface to the methods the hook calls, and let a method return a
value or a promise, so an in-memory store for tests stays synchronous and a
database-backed one does not have to pretend.

The store is given the key's hash, not the key: the application stores
hashes, a database dump holds no working keys, and the lookup by hash is an
ordinary index lookup.

## Report what cannot be answered

Recording when a key was last used should not make the request wait, so
the hook starts the write and does not await it. When the write fails, the
response has already gone its way, and there is nobody to answer with an
error. `reportFailure(ctx, source, error)` hands the failure to the
application's `reportError` — its logger, its error tracker — with the
request's context, so the report carries the request id and whatever else
the application's hooks put there. `source` names the package; any string
will do.

A failure the hook can answer is thrown instead: a store that throws in
`find` becomes a `500` through `onError`, and is reported by the framework
like any failure nothing answered.

## No timers without an owner

A package does not start an interval or a timeout that outlives the
request. A timer keeps the process alive, and whoever created the hook has
no way to stop it — so tests hang and a shutdown waits. When the package
needs something to expire, it sweeps as it is used, the way the rate
limiter's memory store drops old windows once the map has doubled. When it
needs to run in the background, it takes a signal from the application,
which owns the process's lifetime — the `stopping` or `draining` signal of
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/), passed in as an option.

## One slot

A package that seems to need two slots is usually a sign that the core is
missing something. `accessLog()` would have needed a `beforeParse` hook to
note when a request started; the core records `ctx.startedAt` instead, and
the log is one `afterResponse` hook. `cors()` would have needed a
`beforeResponse` hook to add its headers; it sets them on `ctx.out`, which
reaches every response, and is one `beforeParse` hook. If a package of
yours still needs two, [open an issue](https://github.com/tetsujs/tetsu/issues):
the missing piece belongs in the core, where every package gets it.

## Testing

A package is tested the way an application is: mounted on a small
application served by `serve()`, and asked over HTTP. The same test can
check that the document describes the refusal the hook really sends:

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

The store is a `Map` in the test, which is what the interface is for. A
test of the failure report passes a store whose `used` rejects and an
application given a `reportError` that collects what it receives. More on
serving applications in tests is in [Testing](/docs/guides/testing/).

## Publishing

- **`@tetsujs/core` is a peer dependency.** The application and the
  package must share one copy of the core: an `HttpError` from a second
  copy is not an instance of the application's, and its `onError` would
  not recognize the refusal.
- **`@tetsujs/openapi`** is a dependency when the package annotates its
  hook, as it is for `@tetsujs/rate-limit`.
- **Export the options and the hook's type** — `ApiKeyOptions`,
  `ApiKeyHook` — so an application can pass the hook around without
  spelling its type.
- **Say which slot it goes in**, and where in that slot: before or after
  `cors()`, before or after the hooks that provide what it `Requires`.
  The compiler checks what a hook needs, not what should come first. See
  [Groups and mounting](/docs/concepts/groups-and-mounting/).
