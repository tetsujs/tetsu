# @tetsujs/secure-headers

Security headers on every response.

```bash
bun add @tetsujs/secure-headers
```

## Usage

```ts
import { secureHeaders } from "@tetsujs/secure-headers";

const secure = secureHeaders();

createApp({ hooks: { beforeResponse: [secure] }, routes });
```

`secureHeaders()` is one `beforeResponse` hook. Mount it on the
application: that slot sees every outgoing response, errors and `404`s
included.

Sent by default — none of these can break a JSON API:

| Header | Value | |
| --- | --- | --- |
| `x-content-type-options` | `nosniff` | the browser does not guess a content type |
| `x-frame-options` | `DENY` | the response cannot be framed |
| `referrer-policy` | `no-referrer` | URLs with identifiers do not leak to other sites |
| `strict-transport-security` | `max-age=15552000` | HTTPS only, for 180 days |

## HSTS

`includeSubDomains` and `preload` are off by default: the first breaks any
subdomain still served over plain HTTP, and the second takes months to
undo. Turn them on when that is known to be safe:

```ts
secureHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } });
```

`preload` without `includeSubDomains`, or with `maxAge` under a year, makes
`secureHeaders()` throw — the browsers' preload list would reject it.

## Content Security Policy

Not sent unless asked, because a wrong policy breaks pages rather than
APIs. For an API that only answers JSON, `apiPolicy` denies everything:

```ts
import { apiPolicy, secureHeaders } from "@tetsujs/secure-headers";

secureHeaders({ contentSecurityPolicy: apiPolicy });
// default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

If the same application serves a page — the docs page of
[`@tetsujs/openapi`](../openapi), for instance — remove the policy for that
route:

```ts
const allowDocs = hook.beforeResponse((ctx) => {
  if (ctx.route?.path === "/docs") ctx.out.headers.delete("content-security-policy");
});

const secure = secureHeaders({ contentSecurityPolicy: apiPolicy });

createApp({
  hooks: { beforeResponse: [secure, allowDocs] },
  routes: [docs({ info }), apiController()],
});
```

## An exception for one route

A route's own `beforeResponse` hook runs after the application's, so it
can change a header for that route:

```ts
const allowFraming = hook.beforeResponse((ctx) => {
  ctx.out.headers.set("x-frame-options", "SAMEORIGIN");
});

route({
  method: "GET",
  path: "/embeddable",
  hooks: { beforeResponse: [allowFraming] },
  handler: () => page(),
});
```

Setting the header in the handler does not work: the handler runs before
`beforeResponse`, and the application's value replaces it.

## Options

| Option | Default | |
| --- | --- | --- |
| `hsts` | `{ maxAge: 15552000 }` | `maxAge`, `includeSubDomains`, `preload`; `false` turns it off |
| `frameOptions` | `"DENY"` | `"SAMEORIGIN"`, or `false` |
| `referrerPolicy` | `"no-referrer"` | any policy, or `false` |
| `noSniff` | `true` | `false` turns it off |
| `contentSecurityPolicy` | not sent | a policy string; `apiPolicy` is ready-made |

HSTS is sent on every response, including plain HTTP ones, where browsers
ignore it — so it works the same behind any proxy.
