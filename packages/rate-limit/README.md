# @tetsujs/rate-limit

Fixed-window rate limiting as a hook, with a replaceable counter store.

```bash
bun add @tetsujs/rate-limit
```

## Usage

```ts
import { rateLimit } from "@tetsujs/rate-limit";

const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});

createApp({ hooks: { beforeParse: [limit] }, routes });
```

This counts by the client's address. Behind a proxy that address is the
proxy's, and on a server listening on a unix socket there is none —
`undefined`, which skips the limit: see [Choosing a key](#choosing-a-key)
for reading the client's from the proxy.

A request over the limit gets `429` with the standard error body (code
`RATE_LIMITED`) and a `retry-after` header. Every counted request's response
carries `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset`.

`rateLimit()` is one `beforeParse` hook. For one route only, mount it on
the route:

```ts
route({ method: "POST", path: "/feedback", hooks: { beforeParse: [limit] }, handler });
```

The counters live in the instance: one `limit` mounted on two routes or
groups is one budget shared between them. For separate budgets, make two —
two limits on one route too, a short window against bursts and a long one:

```ts
const burst = rateLimit({ limit: 3, windowMs: 1_000, key });
const hourly = rateLimit({ limit: 20, windowMs: 3_600_000, key });

route({ method: "POST", path: "/login", hooks: { beforeParse: [burst, hourly] }, handler });
```

A request passes when it is within both. Each limiter sets the
`x-ratelimit-*` headers, and a response carries the last one's;
`headers: false` on the other keeps them from taking turns.

`perRoute: true` gives each route its own budget from one limiter —
"20 a minute on every endpoint", mounted once on the application:

```ts
const each = rateLimit({ perRoute: true, limit: 20, windowMs: 60_000, key });

createApp({ hooks: { beforeParse: [each] }, routes });
```

A route is its template, so `/orders/1` and `/orders/2` share
`GET /orders/:id`. Requests no route answers — a `404`, a `405`, a CORS
preflight — share one budget between them; with `cors()` before the
limiter, as it goes before every hook that can refuse, a preflight is
answered before it is counted.

## Choosing a key

`key` decides what is counted, and there is no default: the right answer
depends on your deployment. It runs before the request is parsed, so it
reads the request itself — headers, and cookies through Bun's
`ctx.req.cookies` (`ctx.cookies` is not filled in yet) — and what the
`beforeParse` hooks before it returned.

A key has to be something the client cannot choose. A session cookie, a
token or a tenant header is whatever the client sends until something
has verified it: a client that sends a new value each time gets a new,
empty budget each time. And `?? undefined` after a value the client may
leave out skips the limit for everyone who leaves it out. Count by the
connection's address, or by what a hook that verified the client worked
out.

A key another hook already worked out — a user whose session it verified,
a client address — is read from the context, once `key` says it needs it
with `Requires`:

```ts
import { HttpError, hook, signedCookie } from "@tetsujs/core";

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

route({ method: "POST", path: "/orders", hooks: { beforeParse: [auth, perUser] }, handler });
```

`signedCookie()` checks the seal before the body is read, where
`ctx.cookies` is not filled yet; `ctx.req.cookies` holds the sealed string
as the client sent it. Keyed by that string, a client that puts a junk
`session` in front of the real one — which the application skips, and
Bun's `req.cookies` reads — gets a new budget each time.

The limiter then demands the field where it is mounted, like any hook
with `Requires`: mounted before `auth`, or on a route nothing provides it
to, it does not compile.

**Limiting by client address behind a proxy** means reading
`x-forwarded-for`, and the first entry is the wrong one: the client can
send that header itself and choose its own bucket. Count from the end
instead, by the number of proxies of your own in front:

```ts
const trustedHops = 1;

key: (ctx) => {
  const chain = ctx.req.headers.get("x-forwarded-for");

  if (!chain) return ctx.server.requestIP(ctx.req)?.address;

  return chain.split(",").at(-trustedHops)?.trim();
},
```

Without a proxy, `ctx.server.requestIP(ctx.req)?.address` is the client's
address — in the form the server's socket reports it. `Bun.serve` without
a `hostname` listens on both IPv4 and IPv6, and a client that connects
over IPv4 is then `::ffff:203.0.113.7`, not `203.0.113.7`. As a key that
is harmless: one client, one form, one bucket. Compared with a list of
addresses — a trusted proxy, an allow-list — it silently never matches:
strip the `::ffff:` prefix before comparing, or listen on `0.0.0.0`, which
is IPv4 only and turns IPv6 clients away.

**Returning `undefined` skips the limit** for that request. An allowance
has to rest on something the client cannot send: a header such as
`x-internal` is one any client can add, unless a proxy of yours
overwrites it. Allow by the connection's address instead:

```ts
const internal = new Set(["10.0.0.5", "10.0.0.6"]);

key: (ctx) => {
  const address = ctx.server.requestIP(ctx.req)?.address.replace(/^::ffff:/, "");

  return address && internal.has(address) ? undefined : address;
},
```

A health check needs no allowance: mount the limiter on the routes or the
group it protects, and leave `/healthz` outside it.

## Options

| Option | Default | |
| --- | --- | --- |
| `limit` | — | requests allowed per window |
| `windowMs` | — | window length, in milliseconds |
| `key` | — | what is counted; `undefined` skips the limit |
| `perRoute` | `false` | a budget per route rather than one for the limiter |
| `store` | `memoryStore()` | where the counters live |
| `name` | — | required with `store`, and only with it: what tells this limiter's counters apart in it |
| `status` | `429` | status of a refusal |
| `headers` | `true` | send the `x-ratelimit-*` headers |

## A shared store

The default store keeps counters in the process — fine for one server, not
for several behind a load balancer. A store is one method, and may be
asynchronous:

```ts
import type { RateLimitStore } from "@tetsujs/rate-limit";

const redisStore: RateLimitStore = {
  hit: async (key, windowMs) => {
    const count = await redis.incr(key);
    await redis.pexpire(key, windowMs, "NX");
    return { count, resetAt: Date.now() + (await redis.pttl(key)) };
  },
};

rateLimit({
  name: "shop-login",
  store: redisStore,
  limit: 5,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});
```

The expiry is set on every hit, if the key has none yet (`NX`, Redis 7
and later). Set only on the first, a timeout between the two commands
left a counter that never expired, and its client refused for good; set
on every hit, the next request repairs it. On an older Redis, send both
in one `MULTI`.

A limiter given a store needs a `name`, and only such a limiter takes
one. The store finds a counter by its key alone, and the key is the name,
then the client: `shop-login:203.0.113.7`, or
`shop-login:POST:/login:203.0.113.7` with `perRoute`. So:

- Without a store, the budget is the limiter. With one, it is the name:
  every server of a fleet whose limiter has it shares one budget, which
  is what a shared store is for.
- A name is unique across everything that writes to the store. Two
  services on one Redis need two names; the simplest way is to prefix
  every key the store sends to Redis with the service — `shop:` — once,
  in the store, and keep the limiters' names short.
- One name on one store with other settings is refused when the second
  limiter is made: one counter cannot have two limits.

## Notes

- With [`@tetsujs/openapi`](../openapi), every operation the limiter
  guards is documented with a `429`, its `retryAfter` and its
  `retry-after` header, without the routes declaring it.
- A refusal is a thrown `HttpError`, with `retryAfter` in its body, so the
  application's `onError` hooks see it like any other failure — an
  application with its own error format formats this one too.
