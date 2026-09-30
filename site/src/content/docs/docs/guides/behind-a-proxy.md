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
connection. Without a proxy, that is the client. Behind one, it is the
proxy: every request arrives from the same few addresses, whoever sent it.

The proxy passes the client's address on in `x-forwarded-for`. It is a
list, and each proxy on the way appends the address it received the
request from:

```text
x-forwarded-for: <what the client sent>, <client>, <proxy 1>
```

The first entries are whatever the client put in the header before it
reached your first proxy — anything at all. Only the entries your own
proxies appended can be believed, and they are at the end: the address of
the client is the one your outermost proxy wrote, counted from the end by
the number of proxies of yours in front of the server.

The framework does not parse this header, and has no setting for it. How
many proxies stand in front of the server is a fact about the deployment —
one load balancer, a CDN and a load balancer, none on a developer's
machine — and a default would be a guess about it. A wrong guess fails
silently: take one entry too many from the end and every client shares the
proxy's address; take the first and each client chooses its own.

## A hook for the client's address

The count is written once, in a hook of your own that reads the right
entry and adds it to the context:

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

With one load balancer, `trustedHops` is `1`: the last entry is the one it
appended, the address it received the connection from. With a CDN in front
of the load balancer, it is `2`. Without a header — a request that did not
come through a proxy, on a developer's machine — the connection's address
is the client's.

This holds only when every request comes through all `trustedHops`
proxies: each appends to the chain, so it is never shorter than that. A
chain that is shorter means a proxy was bypassed or the count is wrong, and
`at()` returns `undefined`. Keep the server reachable only from the last
proxy — a private network, a firewall rule — so that no request can skip
it.

A proxy that writes a header of its own and overwrites what the client
sent — `x-real-ip` in a common nginx setup — can be read directly instead,
on the same condition.

Mount the hook first in the application's `beforeParse`:

```ts twoslash
import { createApp, hook } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
declare const routes: object;
declare const clientIp: import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { clientIp: string | undefined }>;
declare const logger: { error(fields: object, message: string): void };
// ---cut---
const id = requestId();

createApp({
  hooks: { beforeParse: [clientIp, id] },
  reportError: ({ source, error, ctx }) =>
    logger.error({ err: error, source, requestId: ctx?.requestId, clientIp: ctx?.clientIp }, "tetsu"),
  routes,
});
```

Hooks of the application after it see `ctx.clientIp` typed, and so does
`reportError`, where it is optional since a failure may come before the
hook ran. A route handler that reads it mounts the hook on the route, or
the code that reads it declares `Requires<{ clientIp: string | undefined }>`
— see [Context and its types](/docs/concepts/context/).

`requestId()` has the same question to answer about its own header. By
default it ignores an `x-request-id` the client sent, since trusting it
lets one client stamp another's log lines. Behind a proxy that sets the
header on every request, `requestId({ trustIncoming: true })` keeps the
proxy's id, and the proxy's logs and the application's share it — see
[`@tetsujs/request-id`](/docs/packages/request-id/).

## The IPv4-mapped form

`Bun.serve` without a `hostname` listens on IPv4 and IPv6 at once. A
client that connects over IPv4 is then reported in the IPv4-mapped IPv6
form: `::ffff:203.0.113.7`, not `203.0.113.7`.

As a key to count by, that is harmless — one client, one form, one bucket.
Compared with an address written the ordinary way — a proxy's, an entry of
an allow-list — it never matches, and nothing reports the mismatch. Strip
the prefix before comparing.

That is what a stricter version of the address hook does. It believes
`x-forwarded-for` only on a connection that comes from one of your
proxies, and takes the connection's address otherwise, which also covers a
server that can be reached without going through them:

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

Without the `replace`, `proxies.has(peer)` is `false` for every request
that came over IPv4, and the hook quietly reports the proxy as the client.

The other way out is `hostname: "0.0.0.0"`, which listens on IPv4 only and
reports plain IPv4 addresses — and turns IPv6 clients away. Tests have the
same choice: `serve(app, { hostname: "127.0.0.1" })` — see
[Testing](/docs/guides/testing/#ipv4-and-ipv6).

## Rate limiting behind a load balancer

`rateLimit()` has no default `key`: the option is required. A default would
have been the connection's address, and behind a load balancer that is the
balancer's. Every client would share one bucket; the limiter would keep
working and say nothing, until someone was refused because of a stranger's
traffic. What to count by depends on the deployment, so the application
says it.

Behind a proxy, count by the address the hook above worked out. The
limiter says it needs the field with `Requires`, and the compiler checks
that it is mounted after the hook that provides it:

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

A key of `undefined` skips the limit for that request. Here it comes from
a chain shorter than `trustedHops` — a request that bypassed a proxy —
which is one more reason to keep the server reachable only from the last
one.

Several instances behind one balancer each count in their own memory by
default, so a client gets the limit once per instance. A shared store —
Redis, for one — makes it one budget across the fleet. And a user that a
hook has verified is often a better key than any address. Both are in
[`@tetsujs/rate-limit`](/docs/packages/rate-limit/#choosing-a-key).

## HTTPS that ends at the proxy

A proxy or load balancer usually terminates TLS: the client talks HTTPS to
it, and it talks plain HTTP to the application. Two things follow.

**The request's URL says `http:`.** `ctx.req.url` is built from what
reached the server, so its scheme is `http`, and its host is whatever the
proxy put in `host`. An absolute URL the application sends out — a link in
an email, a redirect to another host — is built from a public origin in
the configuration, not from the request. `x-forwarded-proto` reports the
client's scheme, and is as trustworthy as the proxy that sets it.

**`secure` cookies still work.** `secure: true` is an instruction to the
browser: send this cookie over HTTPS only. The browser's connection is
HTTPS — to the proxy — so it keeps the cookie and sends it back, and the
application sets the attribute the same way whether it sits behind a proxy
or not. A session cookie in production is always `secure`.

Bun can also terminate TLS itself, with the `tls` option of `Bun.serve`,
for a server that faces clients directly.

## HSTS

`secureHeaders()` from `@tetsujs/secure-headers` sends
`strict-transport-security` on every response, which tells a browser to
use HTTPS for the site from then on — for 180 days by default. It is sent
on plain HTTP responses too, where browsers ignore it, so it works the
same behind any proxy: the application does not need to know whether TLS
ended in front of it.

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
// ---cut---
import { secureHeaders } from "@tetsujs/secure-headers";

const secure = secureHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } });

createApp({ hooks: { beforeResponse: [secure] }, routes });
```

`includeSubDomains` and `preload` are off by default: the first breaks any
subdomain still served over plain HTTP, and the second takes months to
undo. Turn them on when that is known to be safe. See
[`@tetsujs/secure-headers`](/docs/packages/secure-headers/#hsts).
