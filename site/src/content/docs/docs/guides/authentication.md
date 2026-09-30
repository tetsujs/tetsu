---
title: Authentication
description: Sessions in a cookie the application signs, a hook that says who is asking before the body is read, sign-in and sign-out routes, bearer tokens and API keys.
sidebar:
  order: 3
---

This page builds sign-in for an API: a session in a cookie the application
signs, a hook that refuses an unknown caller and gives the routes behind it
a typed `ctx.user`, and the routes that start and end a session. Bearer
tokens and API keys follow the same pattern.

The framework has no authentication module and no session store. What it
provides is the pieces — signed cookies, hooks that add to the context,
`Requires` — and a session store is a service of your own. The examples
assume one with three methods: `start(userId)` makes a new random session
id and records whom it belongs to, `find(sessionId)` returns the user or
`undefined` when the id is unknown or expired, and `end(sessionId)`
forgets it. A table, a Redis hash or a map in memory all fit.

## A signed session cookie

The session travels in a cookie, and the application signs it: with a
secret, the cookies `sign` names are sealed on the way out and verified on
the way in.

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object;
declare const env: { COOKIE_SECRET: string };
// ---cut---
createApp({ cookies: { secret: env.COOKIE_SECRET, sign: ["session"] }, routes });
```

The secret is 32 random bytes or more — `openssl rand -base64 32` — read
from the environment in `main.ts` and passed in. An empty or missing one
is refused at startup.

The signature says the value came from this application. It does not hide
it: a signed cookie is readable by the client, so it carries a session id
and nothing else. It also means a forged id is refused without a lookup,
because its seal does not hold. See [Cookies](/docs/concepts/cookies/#signed-cookies).

A cookie that carried the user's id itself, signed, would need no store at
all — and could not be revoked before it expires. Signing out on one
device, or locking an account, needs the store.

## The hook that says who is asking

A hook in `beforeParse` reads the session, asks the store, and either
refuses with `401` or returns the user. What it returns joins the context,
typed, in everything that runs after it:

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

Two choices in it are deliberate.

**`beforeParse`, so the refusal comes before the body.** An upload from
someone who is not signed in is refused before a byte of it is read, and a
rate limit mounted after the hook can count by the user it found.

**`signedCookie()`, not `ctx.cookies`.** `ctx.cookies` is filled when the
request is validated, after the body is read. `signedCookie()` reads the
request's `cookie` header, checks the seal and returns the value without
it, or `undefined` when the cookie is missing or forged. Of a name sent
twice, it takes the first whose seal holds, so a junk `session` put in
front of the real one does not change who the caller is.

A session could also be declared in `schema.cookies`, as any request part
can. A missing or forged one then fails validation — `422`, after the body
is read — which is right for a cookie that is merely expected, and wrong
for one that decides whether the caller may be here at all.

The hook is a factory over the store, the way a hook package is a factory
over its options. A controller builds it from the `sessions` it is given
and mounts it on its routes — see
[Hooks and dependencies](/docs/concepts/controllers/#hooks-and-dependencies).

## Hooks that need the user

A hook that works with the user says so with `Requires`, instead of
depending on where it is mounted. Mounting it where nothing provides
`user` is a compile error that names the missing field:

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

`adminOnly` goes after `signedIn` in the same slot; written the other way
round, it does not compile. `ownNote` needs the validated `params` too, so
it goes in `beforeHandle`, after validation.

On a group, `authenticate` still refuses everyone under it, but `ctx.user`
is not typed in the handlers: a controller is typed where it is written,
not where it is mounted. A route that reads `ctx.user` mounts the hook
itself; a controller whose routes all do writes the set once,
`const signedIn = { beforeParse: [authenticate(sessions)] } as const`, and
passes it to each. See [Context and its types](/docs/concepts/context/).

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

- **A new session at every sign-in.** `start` makes a fresh id rather than
  reusing one the client already had, so an id planted before sign-in is
  worth nothing after it.
- **`httpOnly`** keeps the cookie from the page's scripts; **`secure`**
  keeps it off plain HTTP. The value is signed on the way out without the
  route mentioning it — `session` is in `sign`.
- **Deleting** a cookie needs the `path` and `domain` it was set with: a
  browser treats another path as another cookie. Sharing `cookie` between
  the two routes keeps them the same.
- **Sign-out does not require a session.** It ends one if there is one and
  answers `204` either way, so a client that signs out twice is not told
  anything went wrong.

A wrong password answers `401` with its own code, `BAD_CREDENTIALS`, which
a client can tell from an expired session's `UNAUTHORIZED`. The error
format is in [Errors](/docs/concepts/errors/). To test the flow as a
browser would — sign in, act, sign out — use a client with a cookie jar:
see [Testing](/docs/guides/testing/#a-client-with-a-session).

## Bearer tokens and API keys

A token in the `authorization` header is the same hook with another
source. It refuses what it does not know and returns who is calling:

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

Where the token comes from — a JWT verified with a library, a key looked up
by its hash, an introspection call — is the service's business; the route
sees only `ctx.client`. An API that accepts either a session or a token
has one hook that tries both and returns the same field, so every route
behind it reads one type.

A hook wrapped in `secured()` from `@tetsujs/openapi` puts its scheme and
its `401` in the OpenAPI document for every route it guards. See
[documenting hooks](/docs/packages/openapi/#documenting-hooks).

## Cookies across sites and CSRF

A cookie session and a frontend on the same site need nothing more. The
`lax` cookie above is sent on the site's own requests and on top-level
navigation to it, and kept off requests that other sites' pages make —
which is what stops those pages from acting as the user.

A frontend on another site that sends the session with
`cors({ credentials: true })` needs the cookie set with `secure: true` and
`sameSite: "none"`: the browser keeps a `Lax` cookie off a request from
another site, and refuses `none` without `secure`. That cookie is then
sent on requests from any site, and CORS does not stop them from being
made — it stops the page from reading the answer. A form on another site
can still post to the API with the user's cookie.

With `sameSite: "none"`, check the origin of every request that changes
something. Browsers send `Origin` on such requests; a hook after `cors()`
refuses the ones not on the list:

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

A client that is not a browser sends no `Origin`, and is refused by this
hook; such a client authenticates with a token instead of a cookie.

## Rate limiting sign-in

A sign-in route is where passwords are guessed. A limit by the client's
address refuses a flood before its bodies are read; a limit by the account
being tried, after the body is validated, stops guessing spread across
many addresses. Both are [`@tetsujs/rate-limit`](/docs/packages/rate-limit/#limiting-by-account)
on the same route.

Behind the `authenticate` hook, a limiter can count by user instead of by
address — `key: (ctx: Requires<{ user: User }>) => ctx.user.id`, mounted
after it in `beforeParse`. Keying by the raw cookie would not work: a
client that sends a new value each time gets a new budget each time. And
behind a proxy the address is the proxy's until something says otherwise
— see [Behind a proxy](/docs/guides/behind-a-proxy/).

## WebSockets

A WebSocket handshake is a request, and goes through the same hooks: the
`authenticate` hook refuses it with an ordinary `401`, and what it
returned becomes `socket.data`. See [WebSockets](/docs/concepts/websockets/).
