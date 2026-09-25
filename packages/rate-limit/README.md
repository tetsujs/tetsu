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
  key: (ctx) => ctx.req.cookies?.get("session") ?? undefined,
});

createApp({ hooks: { beforeParse: [limit] }, routes });
```

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
groups is one budget shared between them. For separate budgets, make two.

## Choosing a key

`key` decides what is counted, and there is no default: the right answer
depends on your deployment. It runs before the request is parsed, so it
reads the request itself — headers, and cookies through Bun's
`ctx.req.cookies` (`ctx.cookies` is not filled in yet).

```ts
key: (ctx) => ctx.req.cookies?.get("session") ?? undefined      // per session
key: (ctx) => ctx.req.headers.get("authorization") ?? undefined // per token
key: (ctx) => ctx.req.headers.get("x-tenant") ?? undefined      // per tenant
```

Returning `undefined` skips the limit for that request — for internal
callers or health checks:

```ts
key: (ctx) =>
  ctx.req.headers.get("x-internal") ? undefined : ctx.req.headers.get("authorization") ?? undefined,
```

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
address.

## Options

| Option | Default | |
| --- | --- | --- |
| `limit` | — | requests allowed per window |
| `windowMs` | — | window length, in milliseconds |
| `key` | — | what is counted; `undefined` skips the limit |
| `store` | `memoryStore()` | where the counters live |
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
    if (count === 1) await redis.pexpire(key, windowMs);
    return { count, resetAt: Date.now() + (await redis.pttl(key)) };
  },
};

rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.req.cookies?.get("session") ?? undefined,
  store: redisStore,
});
```

## Notes

- With [`@tetsujs/openapi`](../openapi), every operation the limiter
  guards is documented with a `429`, its `retryAfter` and its
  `retry-after` header, without the routes declaring it.
- A refusal is returned, not thrown — it is cheaper, and a limiter under
  load refuses a lot. So `onError` hooks do not see it; `beforeResponse`
  and `afterResponse` hooks do.
