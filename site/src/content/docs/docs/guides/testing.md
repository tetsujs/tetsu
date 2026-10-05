---
title: Testing
description: Call a handler directly with testCtx(), or send requests to a real server with serve(), a client with a cookie jar, and a check against the OpenAPI document.
sidebar:
  order: 2
---

Tests use two helpers from `@tetsujs/core/testing`, both under `bun test`.
`testCtx()` builds a context to call a handler directly, as a function.
`serve()` starts the application on a real server for everything around the
handler — routing, hooks, validation, the error format — since Bun's router
is only reachable through a socket.

## Calling a handler

A controller is a function of its dependencies, so the test hands in its
own, and `testCtx()` builds the context from the parts the handler reads:

```ts twoslash
import { controller, httpError, route } from "@tetsujs/core";
import { z } from "zod";
interface User { readonly id: string }
interface Note { id: number; title: string }
interface NoteStore { find(owner: string, id: number): Note | undefined }
declare const signedIn: import("@tetsujs/core").Hook<"beforeParse", import("@tetsujs/core").BaseCtx, { user: User }>;
const notesController = controller("Notes", ({ notes }: { notes: NoteStore }) => ({
  get: route({
    method: "GET",
    path: "/notes/:id",
    hooks: { beforeParse: [signedIn] },
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => {
      const note = notes.find(ctx.user.id, ctx.params.id);
      if (!note) throw httpError(404, "NOTE_NOT_FOUND");
      return note;
    },
  }),
}));
// ---cut---
import { expect, test } from "bun:test";
import { HttpError } from "@tetsujs/core";
import { testCtx } from "@tetsujs/core/testing";

const note = { id: 7, title: "first" };
const routes = notesController({
  notes: { find: (owner, id) => (owner === "ada" && id === 7 ? note : undefined) },
});

test("returns the note it finds", () => {
  const ctx = testCtx({ params: { id: 7 }, user: { id: "ada" } });

  expect(routes.get.handler(ctx)).toEqual(note);
});

test("refuses a note that is someone else's", () => {
  const ctx = testCtx({ params: { id: 7 }, user: { id: "grace" } });

  expect(() => routes.get.handler(ctx)).toThrow(HttpError);
});
```

The parts are what the handler would have received: `params` after
validation (a number, since the schema converts it) and `user` from the
route's hook. Leave one out and the call does not compile.

The rest is filled in. `ctx.req` is a request to `http://test/`; pass your
own as `req` when the handler reads it. `ctx.out` collects the status,
headers and cookies the handler sets. `ctx.server` throws when touched:
code that needs it, such as `ctx.server.requestIP()`, is tested through
`serve()`. Only `ctx.server.timeout()` does nothing, since a unit test has
no connection to time out.

### Signed cookies in a unit test

A handler that sets a signed cookie, or reads one with `signedCookie()`,
needs the application's cookie options. Pass them as the second argument:

```ts twoslash
import { route } from "@tetsujs/core";
const signIn = route({
  method: "POST",
  path: "/session",
  handler: (ctx) => {
    ctx.out.cookies.set("session", "s1", { httpOnly: true });
  },
});
// ---cut---
import { expect, test } from "bun:test";
import { testCtx } from "@tetsujs/core/testing";

const cookies = { secret: "a test secret", sign: ["session"] } as const;

test("signing in sets a signed session", () => {
  const ctx = testCtx({ params: {} }, { cookies });

  signIn.handler(ctx);

  expect(ctx.out.headers.get("set-cookie")).toMatch(/^session=s1\.[^;]+/);
});
```

A route without path parameters still gets `params: {}`. With the options,
`signedCookie()` opens a cookie sent in the `cookie` header of the `req`
you pass; without them, it throws and says what is missing.

## Testing through a server

`serve()` starts the application on a free port and returns a function
that sends requests to it. It takes a path and `fetch`'s options:

```ts twoslash
import { createApp, controller, route } from "@tetsujs/core";
const notesController = controller("Notes", () => ({
  get: route({ method: "GET", path: "/notes/:id", handler: () => ({}) }),
  create: route({ method: "POST", path: "/notes", handler: (ctx) => { ctx.out.status = 201; return {}; } }),
}));
// ---cut---
import { describe, expect, test } from "bun:test";
import { serve } from "@tetsujs/core/testing";

const request = serve(createApp({ routes: notesController() }));

describe("notes", () => {
  test("a note is found by its id", async () => {
    const res = await request("/notes/1");

    expect(res.status).toBe(200);
  });

  test("a note is created from JSON", async () => {
    const res = await request("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "first" }),
    });

    expect(res.status).toBe(201);
  });
});
```

The server stops by itself: `serve()` registers an `afterAll` where it is
called, and Bun runs it when that scope ends: the file, the `describe`, or
the test. Outside `bun test`, call `request.stop()` or `stopServers()`.

Bun runs `afterAll` hooks in the order they were registered, so an
`afterAll` of yours registered after `serve()` runs once the server has
stopped. A teardown that still needs the server uses `{ stop: false }`,
shown below, and calls `request.stop()` last.

### Setting up before the server

Not in `beforeAll`: Bun runs an `afterAll` registered inside a hook as
soon as the hook returns, so the server would stop before the first test.
A request to a server that has stopped throws, saying what stopped it.
Await the setup at the top level of the file instead, and call `serve()`
after it:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
interface Database { close(): void }
declare function openDatabase(): Promise<Database>;
const notesController = controller("Notes", ({ db }: { db: Database }) => ({
  list: route({ method: "GET", path: "/notes", handler: () => (db ? [] : []) }),
}));
// ---cut---
import { serve } from "@tetsujs/core/testing";

const db = await openDatabase();

const request = serve(createApp({ routes: notesController({ db }) }));
```

Or keep the hooks and stop the server yourself: with `{ stop: false }`,
it runs until `request.stop()`.

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
interface Database { close(): void }
declare function openDatabase(): Promise<Database>;
const notesController = controller("Notes", ({ db }: { db: Database }) => ({
  list: route({ method: "GET", path: "/notes", handler: () => (db ? [] : []) }),
}));
// ---cut---
import { afterAll, beforeAll } from "bun:test";
import type { RequestFn } from "@tetsujs/core/testing";
import { serve } from "@tetsujs/core/testing";

let request: RequestFn;

beforeAll(async () => {
  const db = await openDatabase();

  request = serve(createApp({ routes: notesController({ db }) }), {
    stop: false,
  });
});

afterAll(() => request.stop());
```

A server starts in under a millisecond, so building the application per
file or per test, on a database in memory, is cheap. See
[Structuring an application](/docs/guides/structuring/).

## A client with a session

A test that signs in and then acts as that user needs the session carried
from one request to the next. `request.client()` returns a client with a
cookie jar that does what a browser would:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
const request = serve(createApp({ routes: [] }));
// ---cut---
import { expect, test } from "bun:test";

test("a session lasts until it is ended", async () => {
  const client = request.client();

  await client("/session", {
    method: "POST",
    json: { email: "ada@example.com", password: "correct horse" },
  });

  expect(client.cookies.get("session")).toBeDefined();
  expect((await client("/me")).status).toBe(200);

  await client("/session", { method: "DELETE" });

  expect(client.cookies.get("session")).toBeUndefined();
  expect((await client("/me")).status).toBe(401);
});
```

- The jar keeps the cookies responses set, sends each where its `Path`
  matches, and forgets one that is deleted or expires. `Domain` is ignored
  and `Secure` cookies go over plain `http`.
- A signed cookie is held as it arrived, signature included.
  `client.cookies.set()` plants a value, to send a forged or stale session.
- `json` sends a value as JSON with its `content-type`; `body` is sent as
  given, a malformed body included.
- Headers are a record. A header set to `null` is not sent, so
  `{ cookie: null }` is a request without the session. Headers passed to
  `request.client({ headers })` go with every request.
- A redirect is returned, not followed, so the test sees the `303` and the
  cookie it set. `redirect: "follow"` follows it, and loses the cookies
  set along the way.

Clients do not share a jar. Make one per test.

## Testing a hook

A hook runs inside a request, so test it through one: mount it on a small
route that returns what the hook added, and serve that.

```ts twoslash
import { hook, HttpError } from "@tetsujs/core";
interface User { readonly id: string }
interface Sessions { find(token: string): User | undefined }
const authenticate = (sessions: Sessions) =>
  hook.beforeParse((ctx) => {
    const user = sessions.find(ctx.req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!user) throw new HttpError(401);
    return { user };
  });
// ---cut---
import { expect, test } from "bun:test";
import { controller, createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";

const sessions = { find: (token: string) => (token === "ada-token" ? { id: "ada" } : undefined) };

const probe = controller("Probe", () => ({
  me: route({
    method: "GET",
    path: "/me",
    hooks: { beforeParse: [authenticate(sessions)] },
    handler: (ctx) => ctx.user,
  }),
}));

const request = serve(createApp({ routes: probe() }));

test("a known token becomes the user", async () => {
  const res = await request("/me", { headers: { authorization: "Bearer ada-token" } });

  expect(await res.json()).toEqual({ id: "ada" });
});

test("an unknown one is refused", async () => {
  expect((await request("/me")).status).toBe(401);
});
```

Logic worth testing on its own, such as parsing a token, belongs in a
plain function the hook calls, tested by calling it.

## Expected failures

Errors no `onError` hook mapped, and handlers that break their response
contract, go to the application's `reportError`, or to `console.error`
without one. A test that provokes one on purpose would print it.
`captureErrors()` collects those lines for each test of its `describe` and
restores the console afterwards. Call it in the `describe` body, not inside
a test:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
const request = serve(createApp({ routes: [] }));
// ---cut---
import { describe, expect, test } from "bun:test";
import { captureErrors } from "@tetsujs/core/testing";

describe("a failing store", () => {
  const errors = captureErrors();

  test("answers 500 and reports what failed", async () => {
    expect((await request("/notes/1")).status).toBe(500);
    expect(errors.lines.join("\n")).toContain("[tetsu]");
  });
});
```

An application with its own `reportError` sends reports there instead; the
test passes one that collects them.

## Checking responses against the OpenAPI document

`assertDescribed()` from `@tetsujs/openapi/testing` checks that a response
a test provoked is one the OpenAPI document declares for its operation:
the status, and a body that fits it. See
[`@tetsujs/openapi`](/docs/packages/openapi/#testing-against-the-document).

## IPv4 and IPv6

`serve()` listens on IPv4 and IPv6 together, as `Bun.serve` does by
default, so an IPv4 client is reported as `::ffff:127.0.0.1`. To test code
that compares addresses as a plain IPv4 client, listen on IPv4:

```ts twoslash
import { createApp } from "@tetsujs/core";
const app = createApp({ routes: [] });
// ---cut---
import { serve } from "@tetsujs/core/testing";

const request = serve(app, { hostname: "127.0.0.1" });
```

[Behind a proxy](/docs/guides/behind-a-proxy/#the-ipv4-mapped-form)
explains the mapped form.

Every request in a test comes from the same address, so a rate limit keyed
by the address counts them all in one bucket. Build the application per
test, or pass the limiter in as a dependency the test controls.
