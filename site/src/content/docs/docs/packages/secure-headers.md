---
title: "@tetsujs/secure-headers"
description: Security headers on every response, as one beforeResponse hook.
sidebar:
  order: 8
  label: "@tetsujs/secure-headers"
---

`@tetsujs/secure-headers` writes the response headers a browser reads as
instructions: no content sniffing, no framing, no referrer leaking, HTTPS only.
It is one hook, and the defaults cannot break a JSON API.

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

`secureHeaders()` is one `beforeResponse` hook. Mount it on the application:
that slot sees every outgoing response, errors and `404`s included. A `401` is
the response an attacker iterates over, and the least useful one to leave
undecorated.

Sent by default, none of which can break a JSON API:

| Header | Value | |
| --- | --- | --- |
| `x-content-type-options` | `nosniff` | the browser does not guess a content type |
| `x-frame-options` | `DENY` | the response cannot be framed |
| `referrer-policy` | `no-referrer` | URLs with identifiers do not leak to other sites |
| `strict-transport-security` | `max-age=15552000` | HTTPS only, for 180 days |

The values do not depend on the request, so they are assembled once, when
`secureHeaders()` is called, and only written per response.

## Options

| Option | Default | |
| --- | --- | --- |
| `hsts` | `{ maxAge: 15552000 }` | `maxAge`, `includeSubDomains`, `preload`; `false` turns it off |
| `frameOptions` | `"DENY"` | `"SAMEORIGIN"`, or `false` |
| `referrerPolicy` | `"no-referrer"` | any policy, or `false` |
| `noSniff` | `true` | `false` turns it off |
| `contentSecurityPolicy` | not sent | a policy string; `apiPolicy` is ready-made |

HSTS is sent on every response, including plain HTTP ones, where browsers are
required to ignore it. It therefore works the same behind any proxy and needs
to know nothing about protocols.

## HSTS

`includeSubDomains` and `preload` are off by default. The first breaks any
subdomain still served over plain HTTP, for as long as `maxAge` says. The
second takes months and a browser release to undo. Turn them on when that is
known to be safe:

```ts twoslash
import { secureHeaders } from "@tetsujs/secure-headers";
// ---cut---
const secure = secureHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } });
```

`preload` without `includeSubDomains`, or with a `maxAge` under a year
(31,536,000 seconds), makes `secureHeaders()` throw: the browsers' preload
list would reject it, and the header would go on promising a submission that
never succeeds.

## Content Security Policy

A policy is not sent unless asked for, because a wrong policy breaks pages
rather than APIs, and the failure is a blank page and a console message on
someone else's machine. For an API that only answers JSON, `apiPolicy` denies
everything:

```ts twoslash
import { apiPolicy, secureHeaders } from "@tetsujs/secure-headers";
// ---cut---
const secure = secureHeaders({ contentSecurityPolicy: apiPolicy });
// default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

Every directive of `apiPolicy` is a denial, so there is nothing in it to tune
for a particular application, and an endpoint it breaks was serving a document
rather than an API.

If the same application serves a page, such as the docs page of
[`@tetsujs/openapi`](/docs/packages/openapi/), remove the policy for that
route, named by the path it is mounted at:

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

`ctx.route.path` is the route's whole path. Mounted in a group, the page at
`/docs` under `/api` is `/api/docs`, and that is what to compare with.

## An exception for one route

A route's own `beforeResponse` hook runs after the application's, so it can
change a header for that route:

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

A policy with `frame-ancestors`, which `apiPolicy` has as `'none'`, is what a
browser follows, and it ignores `x-frame-options` then. Allowing a frame means
changing both. Setting the header in the handler does not work: the handler
runs before `beforeResponse`, and the application's value replaces it.

## Notes

- The package also exports the types `SecureHeadersOptions`, `HstsOptions` and
  `SecureHeadersHook`. Read a hook's type off `secureHeaders()` rather than
  annotating it with `AnyHook`, which erases the slot the hook belongs to.
- Headers are written with `set`, so a header of the same name that a handler
  set is replaced by the application's value.
