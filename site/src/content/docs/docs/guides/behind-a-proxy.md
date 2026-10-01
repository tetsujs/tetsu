---
title: Behind a proxy
description: The client's address behind a proxy or load balancer, rate limiting by it, HTTPS that ends at the proxy, secure cookies and HSTS.
sidebar:
  order: 5
---

This page covers what changes when the application runs behind a reverse
proxy or a load balancer: where the client's address comes from, how to
rate limit by it, and what HTTPS that ends at the proxy means for cookies
and security headers.

## The client's address

`ctx.server.requestIP(ctx.req)` is the address at the other end of the
connection. Behind a proxy, that is the proxy, for every request.

The proxy passes the client's address in `x-forwarded-for`. Each proxy on
the way appends the address it received the request from:

```text
x-forwarded-for: <what the client sent>, <client>, <proxy 1>
```

The client can put anything at the start of the header, so only the
entries your own proxies appended can be trusted. They are at the end: the
client's address is the Nth entry from the end, where N is the number of
your proxies in front of the server.

Tetsu does not parse this header, because N is a fact about your
deployment, and a wrong default fails silently: count one proxy too few and
every client shares a proxy's address; take the first entry and every
client picks its own.

## A hook for the client's address

Write N once, in a hook that adds the address to the context:

```ts twoslash
import { hook } from "@tetsujs/core";
// ---cut---
const trustedHops = 1;

export const clientIp = hook.beforeParse((ctx) => {
  const chain = ctx.req.headers.get("x-forwarded-for");

  if (!chain) {
    return { clientIp: ctx.server.requestIP(ctx.req)?.address };
  }

  return { clientIp: chain.split(",").at(-trustedHops)?.trim() };
});
```

With one load balancer, `trustedHops` is `1`. With a CDN in front of the
load balancer, it is `2`. Without the header, as on a developer's machine,
the connection's address is the client's.

This holds only when every request passes through all your proxies. Keep
the server reachable only from the last one, with a private network or a
firewall rule. If a proxy overwrites a header of its own, such as
`x-real-ip` in a common nginx setup, you can read that instead, on the
same condition.

Mount the hook first in the application's `beforeParse`:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
declare const clientIp: import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { clientIp: string | undefined }>;
declare const logger: { error(fields: object, message: string): void };
// ---cut---
createApp({
  hooks: { beforeParse: [clientIp] },
  reportError: ({ source, error, ctx }) =>
    logger.error({ err: error, source, clientIp: ctx?.clientIp }, "tetsu"),
  routes,
});
```

The application's later hooks see `ctx.clientIp` typed, and so does
`reportError`, where it is optional because a failure may come before the
hook ran. A route handler that reads it mounts the hook on the route, or
declares `Requires<{ clientIp: string | undefined }>` — see
[Context and its types](/docs/concepts/context/).

`requestId()` ignores an incoming `x-request-id` by default, since a
client could stamp another client's log lines. If your proxy sets the
header on every request, `requestId({ trustIncoming: true })` keeps the
proxy's id, so its logs and the application's share it. See
[`@tetsujs/request-id`](/docs/packages/request-id/).

## The IPv4-mapped form

`Bun.serve` without a `hostname` listens on IPv4 and IPv6 at once, and
reports an IPv4 client as `::ffff:203.0.113.7`, not `203.0.113.7`.

As a rate limit key, that is harmless. Compared with an address written
the usual way, such as a proxy's address in a list, it never matches, and
nothing reports it. Strip the prefix before comparing.

A stricter address hook needs this. It trusts `x-forwarded-for` only on a
connection from one of your proxies, and takes the connection's address
otherwise, which also covers a request that bypassed them:

```ts twoslash
import { hook } from "@tetsujs/core";
// ---cut---
const proxies = new Set(["10.0.0.2", "10.0.0.3"]);

export const clientIp = hook.beforeParse((ctx) => {
  const peer = ctx.server.requestIP(ctx.req)?.address.replace(/^::ffff:/, "");
  const chain = ctx.req.headers.get("x-forwarded-for");

  if (!chain || peer === undefined || !proxies.has(peer)) {
    return { clientIp: peer };
  }

  return { clientIp: chain.split(",").at(-1)?.trim() };
});
```

Without the `replace`, `proxies.has(peer)` is `false` for every IPv4
request, and the hook reports the proxy as the client. `at(-1)` assumes one
proxy, as `trustedHops = 1` does above.

The other way out is `hostname: "0.0.0.0"`, which listens on IPv4 only and
turns IPv6 clients away. Tests have the same choice — see
[Testing](/docs/guides/testing/#ipv4-and-ipv6).

## Rate limiting behind a load balancer

`rateLimit()` has no default `key`, because behind a balancer the
connection's address is the balancer's, and every client would share one
bucket; see
[Choosing a key](/docs/packages/rate-limit/#choosing-a-key). Count by the
address the hook worked out. The limiter declares the field
with `Requires`, and the compiler checks that it is mounted after the hook:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
declare const clientIp: import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { clientIp: string | undefined }>;
// ---cut---
import type { Requires } from "@tetsujs/core";
import { rateLimit } from "@tetsujs/rate-limit";

const limit = rateLimit({
  limit: 100,
  windowMs: 60_000,
  key: (ctx: Requires<{ clientIp: string | undefined }>) => ctx.clientIp,
});

createApp({ hooks: { beforeParse: [clientIp, limit] }, routes });
```

A key of `undefined` skips the limit for that request. With the first hook,
that happens when the chain is shorter than `trustedHops`, which means a
request bypassed a proxy.

Several instances each count in their own memory by default, so a client
gets the limit once per instance. A
[shared store](/docs/packages/rate-limit/#a-shared-store), such as Redis,
makes it one budget.

## HTTPS that ends at the proxy

A proxy usually terminates TLS: the client talks HTTPS to it, and it talks
plain HTTP to the application. Two things follow.

**`ctx.req.url` says `http:`**, and its host is whatever the proxy put in
`host`. Build absolute URLs the application sends out, such as links in
emails, from a public origin in your configuration, not from the request.
`x-forwarded-proto` reports the client's scheme, if your proxy sets it.

**`secure` cookies still work.** `secure: true` tells the browser to send
the cookie over HTTPS only, and the browser's connection to the proxy is
HTTPS. Set it the same way with or without a proxy.

Bun can also terminate TLS itself with the `tls` option of `Bun.serve`.

## HSTS

`secureHeaders()` from `@tetsujs/secure-headers` sends
`strict-transport-security` on every response, which tells browsers to use
HTTPS for the site from then on, for 180 days by default. Browsers ignore
it on plain HTTP responses, so the application does not need to know
whether TLS ended in front of it.

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
// ---cut---
import { secureHeaders } from "@tetsujs/secure-headers";

const secure = secureHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } });

createApp({ hooks: { beforeResponse: [secure] }, routes });
```

`includeSubDomains` and `preload` are off by default: the first breaks any
subdomain still on plain HTTP, and the second takes months to undo. See
[`@tetsujs/secure-headers`](/docs/packages/secure-headers/#hsts).
