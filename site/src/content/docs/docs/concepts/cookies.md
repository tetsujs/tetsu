---
title: Cookies
description: Reading cookies through schema.cookies, writing them on ctx.out.cookies, signing them with an application secret, reading a signed cookie early with signedCookie(), and cross-site sessions.
sidebar:
  order: 10
---

Cookies arrive as a request part and leave on `ctx.out`. With a secret,
the application signs the cookies it names on the way out and verifies
them on the way in, without any call site mentioning it.

## Reading cookies

`schema.cookies` validates incoming cookies and adds `ctx.cookies`, typed
by the schema's output:

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

Cookies are a record of strings and are validated like `query`: in the same
phase, with the same `422`. A required cookie that is missing is reported
at `["cookies", "theme"]`. A name sent twice reads as its first value,
which is the host's own cookie rather than one a sibling subdomain set.

Without a schema there is no `ctx.cookies`. Bun's `ctx.req.cookies` holds
the values as the client sent them, unchecked.

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

The attributes are Bun's `CookieInit` without the name and value: `path`,
`domain`, `maxAge`, `expires`, `httpOnly`, `secure`, `sameSite`,
`partitioned`. Left out, Bun's defaults apply: `Path=/` and `SameSite=Lax`.

- **Writing a name twice replaces it.** Different names accumulate.
- **Deleting needs the same `path` and `domain`** the cookie was set with.
  The browser treats a different path as a different cookie.
- **Cookies go out with every response**, including a redirect, an error
  and a hook's short-circuit.

Changes to Bun's `ctx.req.cookies` are sent too, but only
`ctx.out.cookies` signs, and only it works on every response, including
the `404` fallback and unit tests.

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

| `cookies` | |
| --- | --- |
| `secret` | the key, 32 random bytes or more |
| `sign` | a name, a list of names, or `true` for every cookie; `true` when omitted |

A signed cookie is sent as `value.signature`, an HMAC-SHA256 of the value.
`ctx.out.cookies.set("session", "42")` sends `session=42.DESNm6lp…`, and
`ctx.cookies.session` reads `"42"` back.

Generate the secret once and keep it with the application's other secrets:

```bash
openssl rand -base64 32
```

An empty or missing secret is refused at startup with a `TypeError`.

Prefer a list of names over `true`. With `true`, a cookie set by anything
else, such as an analytics script or a proxy, fails verification and reads
as absent.

Signing proves the value came from the application. It does not hide it:
the client can read a signed cookie, so it should hold an identifier, not a
secret.

### A forged signature is treated as absent

A cookie whose signature does not hold is left out. `schema.cookies` then
reports it missing, so a forger cannot tell a bad signature from a cookie
that was never sent.

Cookies a hook returns are checked the same way. A hook that takes a
mobile client's session from a header returns it signed, exactly as the
client sent it; a plain `session: "admin"` is dropped. Cookies passed on
unchanged from `ctx.cookies` are already verified and stay.

## Reading a signed cookie early

`ctx.cookies` is filled at validation, after the body is read. A hook that
authenticates earlier, to refuse before the body is read or to give a rate
limit a user to count, uses `signedCookie()`. It checks the signature and
returns the value without it:

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

- It reads the request's `cookie` header, not what a hook put on the
  context.
- It returns `undefined` when the cookie is missing or its signature does
  not hold. Of a name sent twice, it takes the first value that verifies.
- It throws for a name the application does not sign: that is a bug in
  the code, not in the request.

This is also how a missing session answers `401`. A session required by
`schema.cookies` fails validation with `422` instead, after the body was
read.

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

The default, `Lax`, keeps the cookie off cross-site requests, and browsers
refuse `none` without `secure`. See [`@tetsujs/cors`](/docs/packages/cors/)
for the other half. A cookie sent from any site also needs a check against
cross-site requests; see
[Authentication](/docs/guides/authentication/#cookies-across-sites-and-csrf).

## Testing code that signs

A handler called with `testCtx()` has no application behind it, and so no
secret: pass the application's cookie options as its second argument. A
client from `serve(app).client()` keeps a cookie jar that holds a signed
cookie as it arrived. [Testing](/docs/guides/testing/#signed-cookies-in-a-unit-test)
shows both.
