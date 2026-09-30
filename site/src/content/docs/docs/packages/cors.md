---
title: "@tetsujs/cors"
description: CORS headers and preflight responses as a single beforeParse hook.
sidebar:
  order: 4
  label: "@tetsujs/cors"
---

`@tetsujs/cors` adds the headers a browser needs to let a page on another
origin call the API, and answers the preflight request the browser sends
first. It is one hook.

```bash
bun add @tetsujs/cors
```

## Usage

```ts twoslash
import { controller, createApp, hook, HttpError, route } from "@tetsujs/core";
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
// ---cut---
import { cors } from "@tetsujs/cors";

const browser = cors({ origin: "https://app.example.com" });

createApp({ hooks: { beforeParse: [browser, auth, limit] }, routes });
```

`cors()` is one `beforeParse` hook. It answers a preflight itself, and on
every other request it puts its headers in `ctx.out`, which the core lays over
whatever response leaves: errors, `404`s and refusals from the hooks after it
included. A request whose `Origin` is not allowed gets no CORS headers, and the
browser refuses the answer on the page's side.

## Where to mount it

Mount it on the application, not on a group. Group hooks do not run for `404`,
`405` and `OPTIONS` preflights (see [Groups and
mounting](/docs/concepts/groups-and-mounting/)), so CORS on a group would be
missing from exactly the preflight it is for.

Mount it before every hook that can refuse. A hook before it that refuses,
such as a rate limit or an authentication check, answers before the headers
are written, and the browser cannot read that answer. Placed before those
hooks, `cors()` also answers a preflight before they see it. That matters: a
preflight carries no credentials, and an authentication check would refuse it.

A hook that never refuses can go before it, and then covers preflights too.
After `requestId()`, a preflight's answer carries `x-request-id`; after
`arrivalLog()`, it gets an arrival line. After `cors()`, preflights stay out of
both, so pick by whether you want them in your logs.

```ts twoslash
import { controller, createApp, hook, HttpError, route } from "@tetsujs/core";
import { cors } from "@tetsujs/cors";
import { requestId } from "@tetsujs/request-id";
import { arrivalLog } from "@tetsujs/request-log";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();

const auth = hook.beforeParse((ctx) => {
  if (!ctx.req.headers.get("authorization")) throw new HttpError(401);
});
const browser = cors({ origin: "https://app.example.com" });
// ---cut---
const id = requestId();
const arrival = arrivalLog();

createApp({ hooks: { beforeParse: [id, arrival, browser, auth] }, routes });
```

## Options

| Option | Default | |
| --- | --- | --- |
| `origin` | required | `"*"`, one origin, or a list of origins matched exactly. Each is written as a browser sends it, `https://app.example.com`, or startup refuses it |
| `methods` | `GET, POST, PUT, PATCH, DELETE` | methods allowed in a preflight |
| `headers` | `content-type, authorization` | request headers a browser may send |
| `exposeHeaders` | none | response headers a browser may read |
| `credentials` | `false` | allow cookies and credentials; refused together with `origin: "*"`, which browsers reject, and with `"null"`, which any site can send |
| `maxAge` | `86400` | how long a browser may cache a preflight, in seconds |

A list of origins is matched exactly and the matching one is echoed back,
which is what the header format requires. Nothing is a pattern: `"*"` inside a
list, or an origin containing `*`, is refused at startup, because it would
never match.

An origin is written as a browser sends it: scheme, host and port, and nothing
after. A trailing slash, capitals, a path or a default port never match, so
`cors()` throws at startup and names the origin it means (`did you mean
"https://app.example.com"?`) instead of leaving every request from the site
refused with nothing to say why. Origins with a scheme the URL standard does not
normalize, such as `capacitor://localhost`, `tauri://localhost` or
`chrome-extension://…`, are taken as written, in lowercase. The opaque origin
`"null"`, which a sandboxed frame or a `file:` page sends, is taken as it is
and cannot be combined with `credentials`.

```ts twoslash
import { cors } from "@tetsujs/cors";
// ---cut---
const browser = cors({
  origin: ["https://app.example.com", "https://admin.example.com"],
  credentials: true,
  exposeHeaders: ["x-request-id"],
});
```

## What it sends

On a request from an allowed origin, `access-control-allow-origin` carries the
origin (or `*`). With `credentials`, `access-control-allow-credentials: true`
is added, and with `exposeHeaders`, `access-control-expose-headers`.

A request from an allowed origin with the method `OPTIONS` is answered by the
hook itself with `204`, carrying `access-control-allow-methods`,
`access-control-allow-headers` and `access-control-max-age` besides. It does
not reach the router, the hooks after it or a handler.

## Notes

- **Every answer says `vary: origin`** unless `origin` is `"*"`. The answers
  without CORS headers say it too, to a request with no `Origin` or one that is
  not allowed. A shared cache would otherwise store such an answer as the same
  for everyone and hand it to an allowed site, whose browser would refuse it. A
  `Vary` of the handler's own response is kept: the core merges the two.
- **`"*"` with `credentials` throws** when the hook is made. A browser rejects
  that pair, so the request would fail at the client, where nobody sees why.
- The package also exports the types `CorsOptions` and `CorsHook`. Read a hook's
  type off `cors()` (`ReturnType<typeof cors>`, which is `CorsHook`) rather than
  annotating it with `AnyHook`, which erases the slot the hook belongs to.

See [Writing a hook package](/docs/guides/writing-a-hook-package/) for how a
package like this one is built.
