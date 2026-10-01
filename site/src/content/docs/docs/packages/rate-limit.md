---
title: "@tetsujs/rate-limit"
description: Fixed-window rate limiting as a hook, with a replaceable counter store.
sidebar:
  order: 5
  label: "@tetsujs/rate-limit"
---

`@tetsujs/rate-limit` refuses requests from a client that goes over its budget
for a window of time. It is a hook you mount where the limit applies, and the
counters live in a store you can replace.

```bash
bun add @tetsujs/rate-limit
```

It depends on [`@tetsujs/openapi`](/docs/packages/openapi/), which it uses to
document the refusal.

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { rateLimit } from "@tetsujs/rate-limit";

const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

createApp({ hooks: { beforeParse: [limit] }, routes });
```

This allows 60 requests a minute per client address. Behind a proxy that
address is the proxy's: see [Behind a proxy](#behind-a-proxy).

A request over the limit gets `429` with the standard error body (code
`RATE_LIMITED`, plus `retryAfter` in seconds) and a `retry-after` header. The
refusal is a thrown `HttpError`, so `onError` hooks and a custom error format
apply to it. Every counted response carries `x-ratelimit-limit`,
`x-ratelimit-remaining` and `x-ratelimit-reset` (seconds until the window
ends).

`rateLimit()` is one `beforeParse` hook. To limit one route, mount it on the
route:

```ts twoslash
import { route } from "@tetsujs/core";
import { rateLimit } from "@tetsujs/rate-limit";

const limit = rateLimit({
  limit: 5,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});
// ---cut---
const feedback = route({
  method: "POST",
  path: "/feedback",
  hooks: { beforeParse: [limit] },
  handler: () => ({ received: true }),
});
```

### Budgets

One limiter is one budget: mounted on two routes, it counts both together. For
separate budgets, make two limiters.

Two limiters on one route work too, such as a short window against bursts and
a long one. A request passes when it is within both. Give one of them
`headers: false`, or the two overwrite each other's `x-ratelimit-*` headers:

```ts twoslash
import { route } from "@tetsujs/core";
import { rateLimit } from "@tetsujs/rate-limit";

const key = (ctx: { server: Bun.Server<unknown>; req: Request }) =>
  ctx.server.requestIP(ctx.req)?.address;
// ---cut---
const burst = rateLimit({ limit: 3, windowMs: 1_000, key });
const hourly = rateLimit({ limit: 20, windowMs: 3_600_000, key, headers: false });

const login = route({
  method: "POST",
  path: "/login",
  hooks: { beforeParse: [burst, hourly] },
  handler: () => ({ ok: true }),
});
```

`perRoute: true` gives each route its own budget from one limiter mounted on
the application, for "20 a minute on every endpoint":

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { rateLimit } from "@tetsujs/rate-limit";

const each = rateLimit({
  perRoute: true,
  limit: 20,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

createApp({ hooks: { beforeParse: [each] }, routes });
```

A route is its template, so `/orders/1` and `/orders/2` share
`GET /orders/:id`. Requests no route answers (a `404`, a `405`, an `OPTIONS`
preflight) share one budget, so probing for paths is counted too. With
[`cors()`](/docs/packages/cors/) mounted before the limiter, a preflight is
answered before it is counted.

## Choosing a key

`key` decides what is counted, and there is no default. The right key depends
on the deployment: behind a balancer, a default by address would put every
client in one bucket while the limiter looked fine. Return a string, or
`undefined` to skip the limit for that request.

**A key must be something the client cannot choose.** An unverified cookie,
token or header is whatever the client sends, and a new value each time means
a new, empty budget each time. Count by the connection's address, or by what a
hook has verified.

By default the key runs before the body is parsed, so it reads the request
itself and what earlier `beforeParse` hooks returned. To read a field another hook
provides, declare it with `Requires`:

```ts twoslash
import { hook, HttpError, route, signedCookie, type Requires } from "@tetsujs/core";
// ---cut---
import { rateLimit } from "@tetsujs/rate-limit";

// createApp({ cookies: { secret, sign: ["session"] } }) signs the session
const auth = hook.beforeParse((ctx) => {
  const userId = signedCookie(ctx, "session");
  if (!userId) throw new HttpError(401);
  return { userId };
});

const perUser = rateLimit({
  limit: 100,
  windowMs: 60_000,
  key: (ctx: Requires<{ userId: string }>) => ctx.userId,
});

const createOrder = route({
  method: "POST",
  path: "/orders",
  hooks: { beforeParse: [auth, perUser] },
  handler: (ctx) => ({ owner: ctx.userId }),
});
```

The limiter then requires `userId` wherever it is mounted: placed before
`auth`, or where nothing provides it, it does not compile. See
[Context and its types](/docs/concepts/context/).

`signedCookie()` reads and verifies a signed cookie in `beforeParse`, where
`ctx.cookies` is not filled in yet. Do not key by `ctx.req.cookies`: it holds
the cookie as the client sent it, unverified.

### Behind a proxy

Behind a proxy, the connection's address is the proxy's, and the client's
is in `x-forwarded-for`. Count it from the end of that header, by the
number of your own proxies in front: the first entry is whatever the client
sent, and would let it pick its own bucket.
[Behind a proxy](/docs/guides/behind-a-proxy/#rate-limiting-behind-a-load-balancer)
shows a hook that works the address out and a limiter keyed by it.

A server that listens on IPv4 and IPv6, `Bun.serve`'s default, reports an
IPv4 client as `::ffff:203.0.113.7`. As a key that is fine. To compare it
with a list of addresses, strip the `::ffff:` prefix first, as the next
example does.

### Skipping the limit

Returning `undefined` skips the limit. Base an exemption on the connection's
address, not on a header such as `x-internal`, which any client can send:

```ts twoslash
import { rateLimit } from "@tetsujs/rate-limit";
// ---cut---
const internal = new Set(["10.0.0.5", "10.0.0.6"]);

const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => {
    const address = ctx.server.requestIP(ctx.req)?.address.replace(/^::ffff:/, "");

    return address && internal.has(address) ? undefined : address;
  },
});
```

Likewise, a key such as `header ?? undefined` skips the limit for every client
that leaves the header out. A health check needs no exemption: mount the
limiter on the routes or groups it protects, and leave the probes outside.

## Limiting by account

A limit by address barely slows password guessing: an attacker with many
addresses gets a full budget on each. What works is counting by the account
being tried, and the account is in the body. `slot: "beforeHandle"` runs the
limiter after the body is validated, so the key can read it:

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";

const Login = z.object({ email: z.string(), password: z.string() });
// ---cut---
import { rateLimit } from "@tetsujs/rate-limit";
import type { Requires } from "@tetsujs/core";

const perAccount = rateLimit({
  slot: "beforeHandle",
  limit: 5,
  windowMs: 15 * 60_000,
  key: (ctx: Requires<{ body: { email: string } }>) => ctx.body.email,
});

const perAddress = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

const login = route({
  method: "POST",
  path: "/login",
  schema: { body: Login },
  hooks: { beforeParse: [perAddress], beforeHandle: [perAccount] },
  handler: () => ({ ok: true }),
});
```

The address limit still refuses a flood before reading its bodies, and the
account limit stops guessing across addresses. A limiter can be made for
`beforeParse` (the default), `beforeValidation` or `beforeHandle`, and the
compiler refuses it in any other slot.

## Options

| Option | Default | |
| --- | --- | --- |
| `limit` | required | requests allowed per window: a whole number, `0` or more (`0` refuses everything) |
| `windowMs` | required | window length in milliseconds: positive and finite |
| `key` | required | what is counted; `undefined` skips the limit |
| `perRoute` | `false` | a budget per route rather than one for the limiter |
| `slot` | `"beforeParse"` | `"beforeValidation"` or `"beforeHandle"` to count by what the body holds |
| `store` | `memoryStore()` | where the counters live |
| `name` | none | required with `store`, and only with it |
| `status` | `429` | status of a refusal |
| `headers` | `true` | send the `x-ratelimit-*` headers |

Bad options throw when the limiter is made. For example, a `windowMs` of `NaN`
(what `Number()` of an unset environment variable gives) would otherwise
refuse nothing.

## A shared store

The default `memoryStore()` keeps counters in the process: fine for one server
and for tests, not for several behind a load balancer. A store is one method,
`hit(key, windowMs)`, which counts a hit and returns `{ count, resetAt }`, with
`resetAt` in epoch milliseconds. It may be async:

```ts twoslash
declare const redis: {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number, mode: "NX"): Promise<unknown>;
  pttl(key: string): Promise<number>;
};
// ---cut---
import { rateLimit, type RateLimitStore } from "@tetsujs/rate-limit";

const redisStore: RateLimitStore = {
  hit: async (key, windowMs) => {
    const count = await redis.incr(key);
    await redis.pexpire(key, windowMs, "NX");
    return { count, resetAt: Date.now() + (await redis.pttl(key)) };
  },
};

const limit = rateLimit({
  name: "shop-login",
  store: redisStore,
  limit: 5,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});
```

The expiry is set on every hit, only if the key has none (`NX`, Redis 7 and
later). Set only on the first hit, a timeout between the two commands would
leave a counter that never expires, and its client refused for good. On older
Redis, send both commands in one `MULTI`.

A limiter with a store needs a `name`, which starts every key it counts under:
`shop-login:203.0.113.7`, or `shop-login:POST:/login:203.0.113.7` with
`perRoute`. So the name is the budget:

- Every server of a fleet whose limiter has that name shares one budget, which
  is what a shared store is for.
- A name must be unique across everything that writes to the store. Two
  services on one Redis need different names, or a store that prefixes every
  key with the service.
- Two limiters with one name on one store but different settings are refused.
  The same settings under one name are fine, since every test run and every
  server makes its limiters again.

## Notes

- **In tests, every request comes from one address.** `serve()` and its
  `client()` connect from the test process, so a limiter keyed by address
  counts all requests of a test file in one bucket. Build the application per
  test, or pass it a `key` the test controls. See [Testing](/docs/guides/testing/).
- With [`@tetsujs/openapi`](/docs/packages/openapi/), every operation the
  limiter guards is documented with a `429`, its `retryAfter` and its
  `retry-after` header.
- The package also exports `memoryStore` and the types `RateLimitOptions`,
  `RateLimitHook`, `RateLimitStore`, `WindowState`, `LimitSlot`,
  `OwnCounters` and `SharedCounters`. `RateLimitHook` is a `beforeParse`
  limiter whose key reads only the request; type any other limiter with
  `ReturnType` of its own `rateLimit()` call.
