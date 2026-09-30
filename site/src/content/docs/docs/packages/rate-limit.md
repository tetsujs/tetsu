---
title: "@tetsujs/rate-limit"
description: Fixed-window rate limiting as a hook, with a replaceable counter store.
sidebar:
  order: 5
  label: "@tetsujs/rate-limit"
---

`@tetsujs/rate-limit` refuses the requests of a client that goes over its
budget for a window of time. It is a hook you mount where the limit applies,
and the counters live in a store you can replace.

```bash
bun add @tetsujs/rate-limit
```

The package depends on [`@tetsujs/openapi`](/docs/packages/openapi/), which it
uses to document the refusal, and takes `@tetsujs/core` as a peer dependency.

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

This counts by the client's address. Behind a proxy that address is the
proxy's, and on a server listening on a unix socket there is none: `undefined`,
which skips the limit. [Choosing a key](#choosing-a-key) shows how to read the
client's address from the proxy.

A request over the limit gets `429` with the standard error body (code
`RATE_LIMITED`, plus `retryAfter` in seconds) and a `retry-after` header. Every
counted request's response carries `x-ratelimit-limit`, `x-ratelimit-remaining`
and `x-ratelimit-reset` (seconds until the window ends). The refusal is a
thrown `HttpError`, so the application's `onError` hooks see it like any other
failure, and an application with its own error format formats this one too.

`rateLimit()` is one `beforeParse` hook. For one route only, mount it on the
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

### Budgets and instances

The counters live in the instance: one `limit` mounted on two routes or groups
is one budget shared between them. For separate budgets, make two. Two limits
on one route work too, a short window against bursts and a long one:

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

A request passes when it is within both. Each limiter sets the `x-ratelimit-*`
headers, and a response carries the last one's; `headers: false` on the other
keeps them from taking turns.

`perRoute: true` gives each route its own budget from one limiter, for "20 a
minute on every endpoint", mounted once on the application:

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

A route is its template, so `/orders/1` and `/orders/2` share `GET /orders/:id`.
Requests no route answers, a `404`, a `405` or a CORS preflight, share one
budget between them, so probing paths that do not exist is counted too. With
[`cors()`](/docs/packages/cors/) before the limiter, as it goes before every
hook that can refuse, a preflight is answered before it is counted.

## Choosing a key

`key` decides what is counted, and there is no default: the right answer
depends on your deployment. A default would have to guess a topology, and behind
a balancer the guess puts every client in one bucket while the limiter looks
configured right. The function returns a string, or `undefined` to skip the limit
for that request.

It runs before the request is parsed, so it reads the request itself: headers,
and cookies through Bun's `ctx.req.cookies` (`ctx.cookies` is not filled in
yet), and what the `beforeParse` hooks before it returned.

A key has to be something the client cannot choose. A session cookie, a token
or a tenant header is whatever the client sends until something has verified
it: a client that sends a new value each time gets a new, empty budget each
time. And `?? undefined` after a value the client may leave out skips the limit
for everyone who leaves it out. Count by the connection's address, or by what a
hook that verified the client worked out.

A key another hook already worked out, such as a user whose session it verified
or a client address, is read from the context once `key` says it needs it with
`Requires`:

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

`signedCookie()` checks the seal before the body is read, where `ctx.cookies` is
not filled yet. `ctx.req.cookies` holds the sealed string as the client sent it.
Keyed by that string, a client that puts a junk `session` in front of the real
one, which the application skips and Bun's `req.cookies` reads, gets a new
budget each time.

The limiter then demands the field where it is mounted, like any hook with
`Requires`: mounted before `auth`, or on a route nothing provides it to, it does
not compile. See [Context and its types](/docs/concepts/context/).

### Behind a proxy

Limiting by client address behind a proxy means reading `x-forwarded-for`, and
the first entry is the wrong one: the client can send that header itself and
choose its own bucket. Count from the end instead, by the number of proxies of
your own in front:

```ts twoslash
import { rateLimit } from "@tetsujs/rate-limit";
// ---cut---
const trustedHops = 1;

const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => {
    const chain = ctx.req.headers.get("x-forwarded-for");

    if (!chain) return ctx.server.requestIP(ctx.req)?.address;

    return chain.split(",").at(-trustedHops)?.trim();
  },
});
```

It holds only where the server is reachable through all `trustedHops` proxies
and nothing else: each of them adds to the chain, so it is never shorter than
that. A shorter one, where `at()` gives `undefined` and the limit is skipped,
means a proxy was bypassed or `trustedHops` is wrong. Keep the server off any
address but the last proxy's. See also [Behind a proxy](/docs/guides/behind-a-proxy/).

Without a proxy, `ctx.server.requestIP(ctx.req)?.address` is the client's
address, in the form the server's socket reports it. `Bun.serve` without a
`hostname` listens on both IPv4 and IPv6, and a client that connects over IPv4
is then `::ffff:203.0.113.7`, not `203.0.113.7`. As a key that is harmless: one
client, one form, one bucket. Compared with a list of addresses, a trusted proxy
or an allow-list, it silently never matches. Strip the `::ffff:` prefix before
comparing, or listen on `0.0.0.0`, which is IPv4 only and turns IPv6 clients
away.

### Skipping the limit

Returning `undefined` skips the limit for that request. An allowance has to rest
on something the client cannot send: a header such as `x-internal` is one any
client can add, unless a proxy of yours overwrites it. Allow by the connection's
address instead:

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

A health check needs no allowance: mount the limiter on the routes or the group
it protects, and leave `/healthz` outside it.

## Limiting by account

A limit by address hardly slows down guessing a password: an attacker with many
addresses gets the whole budget on each. The measure that holds counts by the
account being tried, and the account is in the body, which a limiter before the
body cannot read. `slot: "beforeHandle"` runs it after the body is validated,
where the key reads it:

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

The address limit still refuses a flood before its bodies are read, and the
account limit stops the guessing across addresses. A limiter goes in the slot it
was made for, `beforeParse` (the default), `beforeValidation` or `beforeHandle`,
and the compiler refuses it anywhere else, or on a route that does not provide
what its key reads. The same slot holds a limit by a user a `beforeHandle` hook
looked up. A slot after the handler is not offered: by then there is nothing
left to protect.

## Options

| Option | Default | |
| --- | --- | --- |
| `limit` | required | requests allowed per window: a whole number, `0` or more (`0` refuses everything) |
| `windowMs` | required | window length in milliseconds: positive and finite |
| `key` | required | what is counted; `undefined` skips the limit |
| `perRoute` | `false` | a budget per route rather than one for the limiter |
| `slot` | `"beforeParse"` | `"beforeValidation"` or `"beforeHandle"` to count by what the body holds |
| `store` | `memoryStore()` | where the counters live |
| `name` | none | required with `store`, and only with it: what tells this limiter's counters apart in it |
| `status` | `429` | status of a refusal |
| `headers` | `true` | send the `x-ratelimit-*` headers |

The options are checked when the limiter is made, and a bad one throws at
startup. A `windowMs` of `NaN`, which is what `Number()` of an unset environment
variable reads as, or of `0`, would refuse nothing while the headers went on
reporting a budget. A `limit` that is not a whole number, a `slot` that is not
one of the three, a `name` without a `store`, and a `store` without a `name` are
refused too.

## A shared store

The default store, `memoryStore()`, keeps counters in the process: fine for one
server and for tests, not for several behind a load balancer. Expired entries
are dropped in a sweep as the map grows, rather than by a timer, so the store
never keeps the process alive. A store is one method, `hit(key, windowMs)`,
which counts a hit against a key and returns the window it fell into as
`{ count, resetAt }`, with `resetAt` in epoch milliseconds. It may be
asynchronous:

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

The expiry is set on every hit, if the key has none yet (`NX`, Redis 7 and
later). Set only on the first, a timeout between the two commands left a counter
that never expired, and its client refused for good. Set on every hit, the next
request repairs it. On an older Redis, send both in one `MULTI`. A refusal's
`retry-after` is never less than one second, even when a store answers with a
window that is already over, so the client is not told to retry at once.

A limiter given a store needs a `name`, and only such a limiter takes one. The
store finds a counter by its key alone, and the key is the name, then the
client: `shop-login:203.0.113.7`, or `shop-login:POST:/login:203.0.113.7` with
`perRoute`. So:

- Without a store, the budget is the limiter. With one, it is the name: every
  server of a fleet whose limiter has it shares one budget, which is what a
  shared store is for.
- A name is unique across everything that writes to the store. Two services on
  one Redis need two names; the simplest way is to prefix every key the store
  sends to Redis with the service, `shop:`, once, in the store, and keep the
  limiters' names short.
- One name on one store with other settings is refused when the second limiter
  is made: one counter cannot have two limits. The same settings under one name
  are fine, since an application rebuilt for every test, and every server of a
  fleet, makes its limiters again.

## Notes

- **In tests, every request comes from one address.** `serve()` and its
  `client()` connect from the test process, so a limiter keyed by address counts
  one bucket across a test file, and a header does not change the address. Build
  the application per test, or give it the limiter's `key` from outside and pass
  one the test controls. See [Testing](/docs/guides/testing/).
- With [`@tetsujs/openapi`](/docs/packages/openapi/), every operation the limiter
  guards is documented with a `429`, its `retryAfter` and its `retry-after`
  header, without the routes declaring it.
- A refusal is a thrown `HttpError`, with `retryAfter` in its body, so the
  application's `onError` hooks see it like any other failure.
- The package also exports `memoryStore`, the types `RateLimitOptions`,
  `RateLimitHook`, `RateLimitStore`, `WindowState` and `LimitSlot`, and the
  option types `OwnCounters` and `SharedCounters`. A limiter whose key demands
  more than the request, or one made for another slot, is typed by
  `ReturnType` of its own `rateLimit()` call, not by `RateLimitHook`.
