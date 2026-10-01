---
title: "@tetsujs/secure-headers"
description: Security headers on every response, as one beforeResponse hook.
sidebar:
  order: 8
  label: "@tetsujs/secure-headers"
---

`@tetsujs/secure-headers` sets the response headers that tell a browser to
turn off content sniffing, framing and referrer leaks, and to use HTTPS only.
It is one `beforeResponse` hook, and its defaults are safe for a JSON API.

```bash
bun add @tetsujs/secure-headers
```

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { secureHeaders } from "@tetsujs/secure-headers";

const secure = secureHeaders();

createApp({ hooks: { beforeResponse: [secure] }, routes });
```

Mount it on the application, so it covers every response, errors and `404`s
included. Sent by default:

| Header | Value | |
| --- | --- | --- |
| `x-content-type-options` | `nosniff` | the browser does not guess a content type |
| `x-frame-options` | `DENY` | the response cannot be framed |
| `referrer-policy` | `no-referrer` | URLs with identifiers do not leak to other sites |
| `strict-transport-security` | `max-age=15552000` | HTTPS only, for 180 days |

The headers are set with `set`, so they replace a header of the same name that
the handler set.

## Options

| Option | Default | |
| --- | --- | --- |
| `hsts` | `{ maxAge: 15552000 }` | `maxAge`, `includeSubDomains`, `preload`; `false` turns it off |
| `frameOptions` | `"DENY"` | `"SAMEORIGIN"`, or `false` |
| `referrerPolicy` | `"no-referrer"` | any policy, or `false` |
| `noSniff` | `true` | `false` turns it off |
| `contentSecurityPolicy` | not sent | a policy string; `apiPolicy` is ready-made |

## HSTS

HSTS is sent on every response. Browsers ignore it over plain HTTP, so it
works the same behind any proxy.

`includeSubDomains` and `preload` are off by default. The first breaks any
subdomain still served over plain HTTP, for as long as `maxAge` says. The
second takes months and a browser release to undo. Turn them on when you know
they are safe:

```ts twoslash
import { secureHeaders } from "@tetsujs/secure-headers";
// ---cut---
const secure = secureHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } });
```

`preload` without `includeSubDomains`, or with a `maxAge` under one year
(31,536,000 seconds), makes `secureHeaders()` throw, because the browsers'
preload list would reject it.

## Content Security Policy

No policy is sent by default: a wrong policy breaks pages, and the failure
only shows in the browser of whoever loads them. For an API that only answers
JSON, `apiPolicy` denies everything:

```ts twoslash
import { apiPolicy, secureHeaders } from "@tetsujs/secure-headers";
// ---cut---
const secure = secureHeaders({ contentSecurityPolicy: apiPolicy });
// default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

If the same application also serves a page, such as the docs page of
[`@tetsujs/openapi`](/docs/packages/openapi/), remove the policy for that
route:

```ts twoslash
import { controller, createApp, hook, route } from "@tetsujs/core";
import { docs } from "@tetsujs/openapi";
import { apiPolicy, secureHeaders } from "@tetsujs/secure-headers";

const info = { title: "Items API", version: "1.0.0" };
const api = controller("Api", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
// ---cut---
const docsPage = "/docs";

const allowDocs = hook.beforeResponse((ctx) => {
  if (ctx.route?.path === docsPage) ctx.out.headers.delete("content-security-policy");
});

const secure = secureHeaders({ contentSecurityPolicy: apiPolicy });

createApp({
  hooks: { beforeResponse: [secure, allowDocs] },
  routes: [docs({ info, uiPath: docsPage }), api()],
});
```

`ctx.route.path` is the route's full path: mounted in a group under `/api`,
the page is `/api/docs`.

## An exception for one route

A route's own `beforeResponse` hook runs after the application's, so it can
change a header for that route. Setting the header in the handler does not
work: the handler runs first, and the application's hook overwrites it.

```ts twoslash
import { hook, route } from "@tetsujs/core";
declare function page(): Response;
// ---cut---
const allowFraming = hook.beforeResponse((ctx) => {
  ctx.out.headers.set("x-frame-options", "SAMEORIGIN");

  const policy = ctx.out.headers.get("content-security-policy");

  if (policy) {
    ctx.out.headers.set(
      "content-security-policy",
      policy.replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'"),
    );
  }
});

const embeddable = route({
  method: "GET",
  path: "/embeddable",
  hooks: { beforeResponse: [allowFraming] },
  handler: () => page(),
});
```

When the policy has `frame-ancestors`, as `apiPolicy` does, browsers follow it
and ignore `x-frame-options`, so allowing a frame means changing both.

## Notes

- The package also exports the types `SecureHeadersOptions`, `HstsOptions`
  and `SecureHeadersHook`. Type a hook with `ReturnType<typeof secureHeaders>`
  rather than `AnyHook`, which erases the slot the hook belongs to.
