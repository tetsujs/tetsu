---
title: Testing
description: Unit tests that call a handler with testCtx(), integration tests through a real server with serve(), a client with a cookie jar, and contract tests of the error format.
sidebar:
  order: 2
---

This page covers the two halves of testing an application: calling a
handler directly with a context built by `testCtx()`, and sending requests
to a real server started by `serve()`. Both come from
`@tetsujs/core/testing` and run under `bun test`.

A handler keeps its types after it is declared, so it can be called as a
function. Everything that happens around it — routing, hooks, validation,
the error format — happens only on a request, and Bun's router is only
reachable through a socket. That decides which half a test belongs to.

## Calling a handler

`testCtx()` builds the context a handler receives from the parts a test
gives it. A controller is a function of its dependencies, so the test
hands in its own:

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

The parts are what the handler would have been given: `params` after
validation — a number here, since the schema converts it — and `user`,
which the route's hook would have returned. Leave a part out and the call
does not compile, because the handler's type says it reads it.

The rest of the context is filled in: `ctx.req` is a request to
`http://test/`, `ctx.out` collects the status, headers and cookies the
handler sets, and `ctx.route` is a placeholder. `ctx.server` throws when it
is touched, naming the property — code that needs the server, such as
`ctx.server.requestIP()`, is tested through `serve()`. A test that cares
about the request passes its own:
`testCtx({ req: new Request("http://test/notes?full=true") })`.

### Cookies in a unit test

Code that sets a signed cookie, or reads one with `signedCookie()`, needs
the application's cookie options, which a hand-built context does not
have. `testCtx` takes them as its second argument:

```ts twoslash
import { controller, route } from "@tetsujs/core";
import { z } from "zod";
interface Sessions { start(email: string): Promise<string> }
const Credentials = z.object({ email: z.string(), password: z.string() });
const sessionController = controller("Session", ({ sessions }: { sessions: Sessions }) => ({
  signIn: route({
    method: "POST",
    path: "/session",
    schema: { body: Credentials, response: { 204: null } },
    handler: async (ctx) => {
      ctx.out.status = 204;
      ctx.out.cookies.set("session", await sessions.start(ctx.body.email), { httpOnly: true });
    },
  }),
}));
// ---cut---
import { expect, test } from "bun:test";
import { testCtx } from "@tetsujs/core/testing";

const cookies = { secret: "a test secret", sign: ["session"] } as const;
const routes = sessionController({ sessions: { start: async () => "s1" } });

test("signing in sets a signed session", async () => {
  const body = { email: "ada@example.com", password: "correct horse" };
  const ctx = testCtx({ params: {}, body }, { cookies });

  await routes.signIn.handler(ctx);

  expect(ctx.out.headers.get("set-cookie")).toMatch(/^session=s1\.[^;]+/);
});
```

A handler's context always has `params`, so a route without path
parameters is given an empty object. With the options, a cookie set on
`ctx.out.cookies` leaves signed as it would from the application, and `signedCookie()` opens one that the
request's `cookie` header carries. Without them, `signedCookie()` throws
and says what is missing.

## Testing through a server

`serve()` starts the application on a free port and returns a function
that sends requests to it:

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

The request function takes a path and `fetch`'s own options. What it
reaches is the application as it runs in production: Bun's router, every
hook, validation and the error envelope.

The server is stopped when the tests around the call are done: `serve()`
registers its own `afterAll` wherever it is called — at the top of a file,
for the file; inside a `describe`, for that block. A test file cannot
forget to stop it. Outside `bun test` there is no `afterAll`, and
`stopServers()` stops every server `serve()` started.

A server costs under a millisecond to start, so an application built per
test — to start each one from an empty store — is affordable. The notes
application in `examples/app` builds one per file, on a database in
memory:

```ts twoslash
import type { Database as Db } from "bun:sqlite";
declare function buildApp(db: Db): import("@tetsujs/core").App;
// ---cut---
import { Database } from "bun:sqlite";
import { serve } from "@tetsujs/core/testing";

const request = serve(buildApp(new Database(":memory:")));
```

## A client with a session

A test that signs in and then acts as that user has to carry the session
from one request to the next. `request.client()` is a client with its own
headers and a cookie jar, which does what a browser would:

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

The jar follows the rules that matter for one server:

- It keeps every cookie a response sets, and sends each back on requests
  whose path its `Path` matches. A cookie without a `Path` is scoped to
  the directory of the request that set it, as a browser scopes it.
- It forgets a cookie when a response deletes it — `Max-Age=0`, an
  `Expires` in the past or an empty value — and when its time runs out.
- A signed cookie is held as it arrived, signature included: the client
  has no secret, as a browser has none. `client.cookies.set()` plants a
  value as if a response had set it, which is how a test sends a forged
  or stale session.
- `Secure` cookies are sent over plain `http`, since a browser treats
  `localhost` as a secure context, and `Domain` is ignored — there is one
  host.

Each call takes `fetch`'s options, with two differences. `json` sends a
value serialized as JSON with its `content-type`; `body` sends what it is
given as it is, a malformed body included, and the two do not go together.
Headers are a record, and a header set to `null` is not sent at all — even
one the client or its jar would send, so `{ cookie: null }` is a request
without the session.

Headers passed to `client()` go with every request, unless a request names
the same header. A redirect is returned, not followed, so a test sees the
`303` and the cookie it set; `redirect: "follow"` follows it, and loses
the cookies of the responses along the way.

Clients do not share a jar. Make one per test, so that one test's session
does not carry into the next.

## IPv4 and IPv6

`serve()` listens where `Bun.serve` listens by default, on IPv4 and IPv6
together. A client that connects over IPv4 is then reported in the
IPv4-mapped form: `ctx.server.requestIP(ctx.req)?.address` is
`::ffff:127.0.0.1`, not `127.0.0.1`.

That matters to code that compares an address with a list — a trusted
proxy, an allow-list. Such a comparison passes in a test that listens on
IPv4 only and fails against the default, or the other way round. To test
it as an IPv4 client, listen on IPv4:

```ts twoslash
import { createApp } from "@tetsujs/core";
const app = createApp({ routes: [] });
// ---cut---
import { serve } from "@tetsujs/core/testing";

const request = serve(app, { hostname: "127.0.0.1" });
```

The request function then goes to that address, and the application sees
`127.0.0.1`. [Behind a proxy](/docs/guides/behind-a-proxy/#the-ipv4-mapped-form)
has more on the form, and on stripping the prefix before comparing.

Every request of a test comes from the same address, whichever form it
takes. A limiter keyed by the address therefore counts one bucket across a
test file, and a header does not change that. Build the application per
test, or give it the limiter's `key` from outside, as a dependency, and
pass one the test controls.

## Testing a hook

A hook runs in its slot, inside a request, so a hook is tested through a
request: mount it on a route of a small application that shows what the
hook returned, and serve it.

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

The route is the test's own, so it shows exactly what the hook
contributed, and the hook meets a real request — headers, cookies, the
client's address. Logic worth testing on its own, such as reading a token
out of a header, is a plain function the hook calls, and a plain function
is tested by calling it.

## Failures a test provokes

What the framework cannot answer to a client — an error no `onError` hook
mapped, a handler that breaks its response contract — goes to the
application's `reportError`, or to `console.error` without one. A test
that provokes such a failure on purpose prints it, and a suite that prints
expected errors hides the unexpected ones. `captureErrors()` collects the
lines for every test of the `describe` it is called in, and restores the
console afterwards:

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

An application built with its own `reportError` sends the reports there
instead; a test then passes a receiver that collects them.

## The error format as a contract

Every error the framework produces has one shape — `status`, `message`,
`error`, and `issues` on a validation failure — and a client branches on
the `error` code. A contract test checks that what a route answers is what
the OpenAPI document says it answers. `assertDescribed()` from
`@tetsujs/openapi/testing` takes the document, the request as the test
made it, and the response:

```ts twoslash
import { createApp } from "@tetsujs/core";
const app = createApp({ routes: [] });
// ---cut---
import { expect, test } from "bun:test";
import { serve } from "@tetsujs/core/testing";
import { openapi } from "@tetsujs/openapi";
import { assertDescribed } from "@tetsujs/openapi/testing";

const request = serve(app);
const { document } = openapi(app, { info: { title: "Notes", version: "1.0.0" } });

test("a request without a token is refused as documented", async () => {
  const res = await request("/api/notes");

  expect(res.status).toBe(401);
  await assertDescribed(document, "GET /api/notes", res);
});
```

It throws unless the status is declared for that operation and the body is
one the status describes, and it lists every problem at once. The `401`
here is in the document because the authentication hook says so with
`secured()`. An application that replaces the error format with its own
`onError` hook tells the generator about it, and the same test then checks
the new format.

The core does not compare a thrown error with the route's response map at
runtime — a guard's refusal would be reported on every route it runs on.
The test asks about the one response it provoked. See
[Errors](/docs/concepts/errors/) for the envelope, and
[`@tetsujs/openapi`](/docs/packages/openapi/#testing-against-the-document)
for the checker's options.
