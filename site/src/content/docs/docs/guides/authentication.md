---
title: Authentication
description: A session in a signed cookie, a hook that says who is asking before the body is read, sign-in and sign-out routes, bearer tokens and API keys.
sidebar:
  order: 3
---

This page builds sign-in for an API: a session in a signed cookie, a hook
that refuses an unknown caller and gives the routes behind it a typed
`ctx.user`, and the routes that start and end a session. Bearer tokens and
API keys follow the same pattern.

Tetsu has no authentication module and no session store. It provides the
pieces: signed cookies, hooks that add to the context, and `Requires`. The
session store is a service of your own. The examples assume one with three
methods:

- `start(userId)` makes a new random session id and records its owner;
- `find(sessionId)` returns the user, or `undefined` when the id is unknown
  or expired;
- `end(sessionId)` forgets it.

A table, a Redis hash or a map in memory all fit.

## A signed session cookie

With a secret, the cookies named in `sign` are signed on the way out and
verified on the way in:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
declare const env: { COOKIE_SECRET: string };
// ---cut---
createApp({ cookies: { secret: env.COOKIE_SECRET, sign: ["session"] }, routes });
```

Use 32 random bytes or more (`openssl rand -base64 32`), read from the
environment in `main.ts`. An empty or missing secret is refused at startup.

A signature proves the value came from this application, so a forged id is
refused without a lookup. It does not hide the value: the client can read
it, so the cookie carries a session id and nothing else. See
[Cookies](/docs/concepts/cookies/#signed-cookies).

## The hook that says who is asking

A hook in `beforeParse` reads the session, asks the store, and either
refuses with `401` or returns the user. What it returns joins the context,
typed, for everything that runs after it:

```ts twoslash
interface User { readonly id: string; readonly name: string }
interface Sessions {
  start(userId: string): Promise<string>;
  find(sessionId: string): Promise<User | undefined>;
  end(sessionId: string): Promise<void>;
}
interface Note { id: number; title: string }
interface NoteStore { list(owner: string): Promise<Note[]> }
declare const sessions: Sessions;
declare const notes: NoteStore;
// ---cut---
import { HttpError, hook, route, signedCookie } from "@tetsujs/core";

export const authenticate = (sessions: Sessions) =>
  hook.beforeParse(async (ctx) => {
    const id = signedCookie(ctx, "session");
    const user = id === undefined ? undefined : await sessions.find(id);

    if (!user) throw new HttpError(401);

    return { user };
  });

const signedIn = authenticate(sessions);

route({
  method: "GET",
  path: "/notes",
  hooks: { beforeParse: [signedIn] },
  handler: (ctx) => notes.list(ctx.user.id),
  //                                ^?
});
```

- **`beforeParse`** refuses before the body is read, so an upload from a
  stranger costs nothing, and a rate limit mounted after the hook can count
  by user.
- **`signedCookie()`**, not `ctx.cookies`, because `ctx.cookies` is filled
  only after the body is read. `signedCookie()` reads the `cookie` header,
  checks the signature, and returns the value, or `undefined` when the
  cookie is missing or forged.

The hook is a factory over the store. A controller builds it from the
`sessions` it is given — see
[Hooks and dependencies](/docs/concepts/controllers/#hooks-and-dependencies).

## Hooks that need the user

A hook that reads the user declares it with `Requires`. Mounting it where
nothing provides `user` is a compile error that names the missing field:

```ts twoslash
interface User { readonly id: string; readonly name: string; readonly admin: boolean }
interface Note { id: number; owner: string }
interface NoteStore {
  find(owner: string, id: number): Promise<Note | undefined>;
  remove(id: number): Promise<void>;
}
declare const notes: NoteStore;
declare const signedIn: import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { user: User }>;
// ---cut---
import type { Requires } from "@tetsujs/core";
import { HttpError, hook, httpError, route } from "@tetsujs/core";
import { z } from "zod";

const adminOnly = hook.beforeParse((ctx: Requires<{ user: User }>) => {
  if (!ctx.user.admin) throw new HttpError(403);
});

const ownNote = hook.beforeHandle(
  async (ctx: Requires<{ user: User; params: { id: number } }>) => {
    const note = await notes.find(ctx.user.id, ctx.params.id);

    if (!note) throw httpError(404, "NOTE_NOT_FOUND");

    return { note };
  },
);

route({
  method: "DELETE",
  path: "/notes/:id",
  schema: { params: z.object({ id: z.coerce.number() }) },
  hooks: { beforeParse: [signedIn, adminOnly], beforeHandle: [ownNote] },
  handler: async (ctx) => {
    await notes.remove(ctx.note.id);
  },
});
```

`adminOnly` must come after `signedIn`; the other order does not compile.
`ownNote` reads the validated `params`, so it goes in `beforeHandle`.

Mounted on a group, `authenticate` still refuses everyone under it, but
`ctx.user` is not typed in the handlers, so a route that reads it mounts the
hook itself; see
[Context and its types](/docs/concepts/context/#why-a-group-hooks-field-is-not-in-the-handlers-type).

## Signing in and out

Signing in checks the credentials, starts a session and sets the cookie.
Signing out ends the session and deletes the cookie:

```ts twoslash
interface User { readonly id: string; readonly name: string }
interface Sessions {
  start(userId: string): Promise<string>;
  find(sessionId: string): Promise<User | undefined>;
  end(sessionId: string): Promise<void>;
}
interface Accounts { verify(email: string, password: string): Promise<User | undefined> }
declare const authenticate: (sessions: Sessions) => import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { user: User }>;
// ---cut---
import { controller, httpError, route, signedCookie } from "@tetsujs/core";
import { z } from "zod";

const Credentials = z.object({ email: z.email(), password: z.string().min(1) });

const cookie = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

export const sessionController = controller(
  "Session",
  ({ accounts, sessions }: { accounts: Accounts; sessions: Sessions }) => ({
    signIn: route({
      method: "POST",
      path: "/session",
      schema: { body: Credentials, response: { 204: null } },
      handler: async (ctx) => {
        const user = await accounts.verify(ctx.body.email, ctx.body.password);

        if (!user) throw httpError(401, "BAD_CREDENTIALS", "Wrong email or password");

        const id = await sessions.start(user.id);

        ctx.out.cookies.set("session", id, { ...cookie, maxAge: 7 * 24 * 3600 });
        ctx.out.status = 204;
      },
    }),

    signOut: route({
      method: "DELETE",
      path: "/session",
      schema: { response: { 204: null } },
      handler: async (ctx) => {
        const id = signedCookie(ctx, "session");

        if (id !== undefined) await sessions.end(id);

        ctx.out.cookies.delete("session", cookie);
        ctx.out.status = 204;
      },
    }),

    me: route({
      method: "GET",
      path: "/me",
      hooks: { beforeParse: [authenticate(sessions)] },
      handler: (ctx) => ({ id: ctx.user.id, name: ctx.user.name }),
    }),
  }),
);
```

- **A new session id at every sign-in**, so an id planted before sign-in is
  worth nothing after it.
- **`httpOnly`** keeps the cookie from the page's scripts; **`secure`**
  keeps it off plain HTTP. The value is signed without the route doing
  anything, because `session` is in `sign`.
- **Deleting** a cookie needs the `path` and `domain` it was set with.
  Sharing `cookie` between the two routes keeps them the same.
- **Sign-out answers `204` either way**, so signing out twice is not an
  error.

A wrong password answers `401` with its own code, `BAD_CREDENTIALS`, which
a client can tell apart from an expired session's `UNAUTHORIZED`. To test
the whole flow, use a client with a cookie jar — see
[Testing](/docs/guides/testing/#a-client-with-a-session).

## Bearer tokens and API keys

A token in the `authorization` header is the same hook with another
source:

```ts twoslash
interface Client { readonly id: string; readonly scopes: readonly string[] }
interface ApiKeys { find(key: string): Promise<Client | undefined> }
// ---cut---
import { HttpError, hook } from "@tetsujs/core";

export const apiKey = (keys: ApiKeys) =>
  hook.beforeParse(async (ctx) => {
    const header = ctx.req.headers.get("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7) : "";
    const client = key === "" ? undefined : await keys.find(key);

    if (!client) throw new HttpError(401);

    return { client };
  });
```

How the token is checked — a JWT library, a key looked up by its hash — is
the service's business; the route sees only `ctx.client`. To accept either
a session or a token, write one hook that tries both and returns the same
field.

Wrap the hook in `secured()` from `@tetsujs/openapi` to put its scheme and
its `401` in the OpenAPI document. See
[documenting hooks](/docs/packages/openapi/#documenting-hooks).

## Cookies across sites and CSRF

With the frontend on the same site, the `lax` cookie above needs nothing
more. Browsers send it on the site's own requests and on navigation to it,
but not on a form post or a `fetch` from another site's page, and that is
what stops those pages from acting as the user.

A frontend on another site needs the cookie set with `secure: true` and
`sameSite: "none"`, and `cors({ credentials: true })`; see
[Cookies](/docs/concepts/cookies/#cross-site-cookies-and-cors). The browser
then sends the cookie on requests from any site. CORS stops another page
from reading the answer, not from sending the request: a form on another
site can still post to the API with the user's cookie.

So with `sameSite: "none"`, check the `Origin` of every request that
changes something. A hook after `cors()` refuses the ones not on the list:

```ts twoslash
import { httpError, hook } from "@tetsujs/core";
// ---cut---
const trusted = new Set(["https://app.example.com"]);
const safe = new Set(["GET", "HEAD", "OPTIONS"]);

const sameOrigin = hook.beforeParse((ctx) => {
  if (safe.has(ctx.req.method)) return;

  const origin = ctx.req.headers.get("origin");

  if (!origin || !trusted.has(origin)) throw httpError(403, "ORIGIN_NOT_ALLOWED");
});
```

A client that is not a browser sends no `Origin` and is refused here; it
should authenticate with a token instead of a cookie.

## Rate limiting sign-in

Sign-in is where passwords are guessed. Limit it twice: by the client's
address, before the body is read, and by the account being tried, after
validation, which stops guessing spread across many addresses. See
[`@tetsujs/rate-limit`](/docs/packages/rate-limit/#limiting-by-account).

Behind `authenticate`, a limiter can count by user instead:
`key: (ctx: Requires<{ user: User }>) => ctx.user.id`, mounted after it in
`beforeParse`. Do not key by the raw cookie: a client that sends a new
value each time gets a new budget each time. Behind a proxy, the address
is the proxy's until you say otherwise — see
[Behind a proxy](/docs/guides/behind-a-proxy/).

## WebSockets

A WebSocket handshake is a request and goes through the same hooks.
`authenticate` refuses it with an ordinary `401`, and the user it returns
is `socket.data.user`. See [WebSockets](/docs/concepts/websockets/).
