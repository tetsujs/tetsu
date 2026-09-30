---
title: Cookies
description: Reading cookies through schema.cookies, writing them on ctx.out.cookies, signing them with an application secret, reading a signed cookie early with signedCookie(), and cross-site sessions.
sidebar:
  order: 10
---

Cookies arrive as a request part and leave on `ctx.out`, and the ones the
application names can be signed on the way out and verified on the way in
without a call site mentioning it. This page covers reading and writing
cookies, signing, reading a signed cookie before validation, cookies sent
across sites, and testing code that signs.

## Reading cookies

Incoming cookies are a request part like the query: `schema.cookies`
validates them and adds `ctx.cookies`, typed by the schema's output.

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
// ---cut---
const Prefs = z.object({ theme: z.enum(["light", "dark"]).default("light") });

route({
  method: "GET",
  path: "/prefs",
  schema: { cookies: Prefs },
  handler: (ctx) => ({ theme: ctx.cookies.theme }),
  //                                      ^?
});
```

They arrive as one header and are a record of strings by the time they are
checked, so they are validated exactly like `query`: in the same phase,
with the same `422`, their issues collected with the other parts'. A
cookie the schema requires and the request does not carry is a missing
field, reported as `["cookies", "theme"]`.

A name sent twice reads as its first value. A browser sends the host's own
cookie before one a sibling subdomain set for the whole domain, and the
last one would be the sibling's.

Without a schema there is no `ctx.cookies`. Bun's own `ctx.req.cookies`, a
`CookieMap`, is on a request that matched a route, and holds the values as
the client sent them, with nothing checked.

## Writing cookies

Outgoing cookies are written by name on `ctx.out.cookies`:

```ts twoslash
import { route } from "@tetsujs/core";
declare const sessions: { open(): Promise<string> };
// ---cut---
route({
  method: "POST",
  path: "/session",
  handler: async (ctx) => {
    ctx.out.cookies.set("session", await sessions.open(), { httpOnly: true, maxAge: 3600 });
    ctx.out.cookies.delete("flash");
  },
});
```

The attributes are Bun's `CookieInit` without the name and the value:
`path`, `domain`, `maxAge`, `expires`, `httpOnly`, `secure`, `sameSite`,
`partitioned`. Bun's defaults apply to what is left out, `Path=/` and
`SameSite=Lax`.

- **Writing a name twice replaces it.** Cookies of different names
  accumulate — a response may rotate a session and clear a flash message
  at once — but a second `set` of the same name replaces the first rather
  than sending both.
- **Deleting needs the same `path` and `domain`.** A browser treats a
  cookie with a different path as a different cookie, and clearing the
  wrong one looks identical from the server.
- **Cookies go out with every response.** They are `set-cookie` headers on
  `ctx.out.headers`, which are laid over whatever leaves: a redirect, an
  error, a hook's short-circuit.

Changes made to Bun's `ctx.req.cookies` are sent too, by Bun itself.
`ctx.out.cookies` is the one that signs, and works on every response,
including the `404` fallback and in unit tests.

## Signed cookies

Give the application a secret, and the cookies it names are signed on the
way out and verified on the way in:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({
  cookies: { secret: Bun.env.COOKIE_SECRET!, sign: ["session"] },
  routes,
});
```

A signed cookie is sent as `value.signature`, the signature an HMAC-SHA256
of the value under the secret. `ctx.out.cookies.set("session", "42")`
sends `session=42.DESNm6lp…`, and `ctx.cookies.session` reads `"42"` back.
No call site mentions the signature, which is the point: it cannot be
forgotten on one of them.

It is configuration rather than schema. A secret is not a shape, so it has
no place in `schema.cookies`, and which cookies are sealed is the
application's policy rather than one endpoint's.

| `cookies` | |
| --- | --- |
| `secret` | the key, 32 random bytes or more |
| `sign` | a name, a list of names, or `true` for every cookie; `true` when omitted |

The secret is generated once and kept with the application's other
secrets:

```bash
openssl rand -base64 32
```

An empty or missing secret is refused at startup with a `TypeError`: with
it, anyone could compute the signature, and a forged cookie would read as
the application's own. A missing environment variable under `!` is caught
the same way.

A list of names is the safer of the two forms of `sign`. Signing every
cookie means a cookie set by anything other than this application — an
analytics script, a proxy — fails verification and reads as absent, which
is a confusing way to discover the setting.

Signing answers "did this value come from us", not "can this be seen". The
value is not encrypted: the client can read it, so a signed cookie holds an
identifier, not a secret.

### A forged signature is treated as absent

A cookie whose signature does not hold is left out, not passed on broken.
`schema.cookies` then reports it missing, which is what it is: the
application has nothing from this client under that name. A forged session
and no session look the same from outside, so a forger cannot tell a bad
signature from a cookie that was never sent.

The same rule holds whichever way a value came. A hook may supply cookies
by returning `cookies` — a mobile client's session taken from a header,
for instance — and under a signed name, what it returns is checked as the
request's cookies are, in any slot. What a hook puts there is the sealed
value, as the client sent it; an unsigned `session: "admin"` does not reach
a handler as a session. A hook that passes `ctx.cookies` on unchanged keeps
the values already opened.

## Reading a signed cookie early

`ctx.cookies` is filled when the request is validated, after the body is
read. A hook that authenticates before that — to refuse before the body is
read, or to give a rate limit a user to count — reads a signed cookie with
`signedCookie()`, which checks the signature and returns the value without
it:

```ts twoslash
import { hook, HttpError, route, signedCookie } from "@tetsujs/core";
// ---cut---
const auth = hook.beforeParse((ctx) => {
  const userId = signedCookie(ctx, "session");

  if (!userId) throw new HttpError(401);

  return { userId };
});

route({
  method: "GET",
  path: "/me",
  hooks: { beforeParse: [auth] },
  handler: (ctx) => ({ id: ctx.userId }),
});
```

It reads the request's `cookie` header, and nothing a hook put on the
context. Of a name sent twice, it takes the first value whose signature
holds: a junk value placed in front of the real one is skipped rather than
read. It returns `undefined` when the cookie is missing or its signature
does not hold.

A name the application does not sign, or an application that signs
nothing, is a mistake in the code rather than in the request, and
`signedCookie()` throws: its value would be whatever the client sent,
under a name that says it was checked.

This is also how a missing session answers `401`. A session required by
`schema.cookies` is a request part, and one that is missing or forged
fails validation with `422` — after the body was read.

## Cross-site cookies and CORS

A frontend on another site that sends the session with
`cors({ credentials: true })` needs the cookie set with `secure: true` and
`sameSite: "none"`:

```ts twoslash
import { route } from "@tetsujs/core";
declare const token: string;
// ---cut---
route({
  method: "POST",
  path: "/session",
  handler: (ctx) => {
    ctx.out.cookies.set("session", token, { httpOnly: true, secure: true, sameSite: "none" });
  },
});
```

The browser's default, `Lax`, keeps a cookie off a request from another
site, and `none` is refused by the browser without `secure`. See
[`@tetsujs/cors`](/docs/packages/cors/) for the other half.

## Testing code that signs

A handler called directly with `testCtx()` has no application behind it,
so it has no secret. The second argument gives it the application's cookie
options: a cookie the code sets is signed as it would be, and
`signedCookie()` opens one the request carries.

```ts twoslash
import { route } from "@tetsujs/core";
import { testCtx } from "@tetsujs/core/testing";
import { expect, test } from "bun:test";

const login = route({
  method: "POST",
  path: "/login",
  handler: (ctx) => {
    ctx.out.cookies.set("session", "42", { httpOnly: true });
  },
});

test("the session is signed", () => {
  const ctx = testCtx({ params: {} }, { cookies: { secret: "test-secret", sign: ["session"] } });

  login.handler(ctx);

  expect(ctx.out.headers.get("set-cookie")).toMatch(/^session=42\.[\w-]+;/);
});
```

Through a real server, `serve()` from `@tetsujs/core/testing` gives a
client with a cookie jar that holds a signed cookie as it arrived — see
[Testing](/docs/guides/testing/).
