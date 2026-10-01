---
title: "@tetsujs/cors"
description: CORS headers and preflight responses as one beforeParse hook.
sidebar:
  order: 4
  label: "@tetsujs/cors"
---

`@tetsujs/cors` lets a page on another origin call the API. It is one
`beforeParse` hook: it answers the browser's preflight request and adds the
CORS headers to every other response.

```bash
bun add @tetsujs/cors
```

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { cors } from "@tetsujs/cors";

const browser = cors({ origin: "https://app.example.com" });

createApp({ hooks: { beforeParse: [browser] }, routes });
```

On a request from an allowed origin, the hook puts its headers in `ctx.out`,
which the core applies to whatever response leaves, errors and `404`s
included. A request from any other origin gets no CORS headers, and the
browser keeps the answer from the page.

## Where to mount it

Mount it on the application, not on a group. Group hooks do not run for
`404`, `405` and `OPTIONS` preflights (see [Groups and
mounting](/docs/concepts/groups-and-mounting/)), so CORS on a group would miss
the preflight it is for.

Mount it before every hook that can refuse, such as an authentication check
or a rate limit. A refusal from a hook placed before `cors()` goes out without
CORS headers, and the browser cannot read it. A preflight also carries no
credentials, so an authentication check placed first would refuse it.

```ts twoslash
import { controller, createApp, hook, HttpError, route } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { rateLimit } from "@tetsujs/rate-limit";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();

const auth = hook.beforeParse((ctx) => {
  if (!ctx.req.headers.get("authorization")) throw new HttpError(401);
});
const limit = rateLimit({
  limit: 60,
  windowMs: 60_000,
  key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
});
const browser = cors({ origin: "https://app.example.com" });
// ---cut---
createApp({ hooks: { beforeParse: [browser, auth, limit] }, routes });
```

Hooks that never refuse, such as `requestId()` and `arrivalLog()`, can go
before it. Preflights then get a request id and an arrival line too; placed
after it, they get neither.

## Options

| Option | Default | |
| --- | --- | --- |
| `origin` | required | `"*"`, one origin, or a list of origins |
| `methods` | `GET, POST, PUT, PATCH, DELETE` | methods allowed in a preflight |
| `headers` | `content-type, authorization` | request headers a browser may send |
| `exposeHeaders` | none | response headers a browser may read |
| `credentials` | `false` | allow cookies and credentials; refused with `origin: "*"` and with `"null"` |
| `maxAge` | `86400` | how long a browser may cache a preflight, in seconds |

```ts twoslash
import { cors } from "@tetsujs/cors";
// ---cut---
const browser = cors({
  origin: ["https://app.example.com", "https://admin.example.com"],
  credentials: true,
  exposeHeaders: ["x-request-id"],
});
```

Write each origin as a browser sends it: scheme, host and port, in lowercase,
with nothing after. Origins are compared exactly, so `https://app.example.com/`
or `https://App.example.com` would never match. `cors()` throws at startup
instead and names the origin you meant. Patterns are not supported: an origin
containing `*` is refused.

Custom schemes such as `capacitor://localhost` or `chrome-extension://…` work
as long as they are written in lowercase. `"null"`, which sandboxed frames and
`file:` pages send, is accepted, but not together with `credentials`, since any
site can send it.

## What it sends

On a request from an allowed origin:

- `access-control-allow-origin`: the request's origin, or `*`;
- `access-control-allow-credentials: true`, with `credentials`;
- `access-control-expose-headers`, with `exposeHeaders`.

An `OPTIONS` request from an allowed origin is answered by the hook itself with
`204`, plus `access-control-allow-methods`, `access-control-allow-headers` and
`access-control-max-age`. It does not reach later hooks or a handler.

Unless `origin` is `"*"`, every response carries `vary: origin`, including
those without CORS headers. Without it, a shared cache could serve one origin's
answer to another. A `Vary` header the handler set is kept and merged.

## Notes

- The package also exports the types `CorsOptions` and `CorsHook`. Type a hook
  with `ReturnType<typeof cors>` (which is `CorsHook`) rather than `AnyHook`,
  which erases the slot the hook belongs to.
- [Writing a hook package](/docs/guides/writing-a-hook-package/) shows how a
  package like this one is built.
