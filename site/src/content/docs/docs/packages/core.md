---
title: "@tetsujs/core"
description: The Tetsu framework itself — install, requirements, everything the package exports, and the testing entry point.
sidebar:
  order: 1
  label: "@tetsujs/core"
---

`@tetsujs/core` is the framework: controllers, routes, lifecycle hooks in
fixed slots, validation, cookies, WebSockets and the request pipeline. It has
no runtime dependencies. This page lists what the package exports and where
each part is explained; the model itself is in the
[key concepts](/docs/key-concepts/) and the Concepts section.

## Install

```bash
bun add @tetsujs/core
```

The package requires Bun 1.4 or later and TypeScript 5.7 or later with
`strict` on. Its types name Bun's own (`Bun.Server`, `CookieMap`), so the
project needs `@types/bun`: `bun init` adds it, and `bun add -d @types/bun`
does otherwise. `moduleResolution` is `bundler`, which is what `bun init`
writes, or `node16` or `nodenext`. The packages declare their entry points in
`exports`, which the old `node` mode does not read, and it reports
`@tetsujs/core` as not found. [Installation](/docs/installation/) covers the
rest of the setup.

The package has two entry points: `@tetsujs/core` for the framework and
[`@tetsujs/core/testing`](#testing) for test helpers.

## What it exports

### Building an application

| Export | What it is | Explained in |
| --- | --- | --- |
| `createApp` | Turns routes, hooks and options into an application: the object you spread into `Bun.serve`. | [createApp](/docs/reference/create-app/) |
| `route` | Declares one route: method, path, `schema`, hooks and handler. | [Routes and handlers](/docs/concepts/routes-and-handlers/) |
| `controller` | Names a function from its dependencies to its routes. | [Controllers and dependencies](/docs/concepts/controllers/) |
| `group` | Puts routes and other groups under a path prefix, with hooks of their own. | [Groups and mounting](/docs/concepts/groups-and-mounting/) |
| `hook` | Factories, one per slot, that build a lifecycle hook: `hook.beforeParse`, `hook.beforeHandle`, `hook.onError` and the rest. | [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) |
| `ws` | Declares a WebSocket endpoint. | [WebSockets](/docs/concepts/websockets/) |
| `onMount` | The symbol a controller uses as a method name to be handed the built application, once, before `createApp` returns. | [Controllers and dependencies](/docs/concepts/controllers/) |

### Errors and failures

| Export | What it is | Explained in |
| --- | --- | --- |
| `HttpError` | An error that carries a status and a body; the pipeline answers with both. | [Errors](/docs/concepts/errors/) |
| `httpError` | Builds an `HttpError` whose body is the standard envelope, with an error code of your own. | [Errors](/docs/concepts/errors/) |
| `errorBody` | Builds the envelope `{ status, message, error }` for a status, for a hook that answers with a `Response` of its own. | [Errors](/docs/concepts/errors/) |
| `ValidationError` | The `HttpError` thrown when a request part fails its schema; it carries the `issues`. | [Validation](/docs/concepts/validation/) |
| `ResponseContractError` | What is reported when a handler answers with a status its response map does not declare, or a body its schema rejects. The client gets a `500`. | [Responses](/docs/concepts/responses/) |
| `reportFailure` | Hands a failure the code at hand cannot answer to the application's `reportError` receiver, as the framework does itself. | [Errors](/docs/concepts/errors/) |

### Schemas and cookies

| Export | What it is | Explained in |
| --- | --- | --- |
| `toJsonSchema` | Reads the JSON Schema of a Standard Schema value that supports conversion, or `undefined`. Documentation tooling uses it. | [Validation](/docs/concepts/validation/) |
| `signedCookie` | Opens a signed cookie from the request's `cookie` header, before the request is parsed, where `ctx.cookies` is not filled yet. | [Cookies](/docs/concepts/cookies/#signed-cookies) |

### Recognizing what was declared

| Export | What it is |
| --- | --- |
| `isRoute` | Whether a value is a route declared by `route()`. |
| `isGroup` | Whether a value is a group declared by `group()`. |
| `isWs` | Whether a value is a socket endpoint declared by `ws()`. |

These are for code that walks a tree of routes and groups, such as a
documentation generator. An application rarely needs them.

### Types

Everything else the package exports is a type. The ones an application names
most often:

- `App`, `AppConfig` and `AppOptions`, for what `createApp` takes and returns.
- `BaseCtx` and the contexts of each stage, `EarlyCtx`, `ValidatedCtx`,
  `HandlerCtx`, `ResponseCtx` and `ErrorCtx`, with `Requires` to declare what
  a hook needs from the context. See [Context and its types](/docs/concepts/context/).
- `Hook`, `AnyHook`, `SlotName` and `SentResponse`, for hooks and the slots
  they belong to, with `HooksConfig` and `MergedHooks` for a set of them. See
  [Lifecycle hooks](/docs/concepts/lifecycle-hooks/).
- `RouteConfig`, `RouteDef`, `RouteDocs`, `Method` and `ResponseEntry`, for
  routes; `GroupConfig` and `GroupNode` for groups; `WsConfig`, `WsDef`,
  `Socket` and `SocketData` for sockets.
- `AnySchema`, `InferInput`, `InferOutput` and the `Standard*` types, for
  [validation](/docs/concepts/validation/) with any Standard Schema library.
- `ErrorBody`, `ValidationIssue`, `FailureReport`, `FailureSource` and
  `ReportError`, for [errors](/docs/concepts/errors/) and `reportError`.
- `CookieOptions`, `CookieAttributes` and `ResponseCookies`, for
  [cookies](/docs/concepts/cookies/).
- `RouteMap`, `RoutesOf` and `RouteSignature`, which describe an
  application's routes by method and path.

The compile-time messages of the framework are types as well: `PathError`,
`HookSlotError`, `HookStackError`, `HookRequirementError` and `ResultError`
are what the compiler prints when a path, a hook or a handler result is wrong.

## Testing

`@tetsujs/core/testing` is published with the core. It imports `bun:test`, so it
belongs in test files. Three helpers cover most tests, and a fourth catches
the framework's own error output.
[Testing](/docs/guides/testing/) shows them in use.

### serve

`serve(app, options?)` starts the application on an ephemeral port, the way
production serves it, and returns a function that sends a request to it. Bun's
router is reachable only through a socket, so an integration test goes through
a real server. Under `bun test` the server is stopped when the test file
finishes.

```ts twoslash
import { expect, test } from "bun:test";
import { controller, createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";
// ---cut---
const users = controller("Users", () => ({
  list: route({ method: "GET", path: "/users", handler: () => [] }),
}));

const request = serve(createApp({ routes: users() }));

test("lists users", async () => {
  const res = await request("/users");

  expect(res.status).toBe(200);
});
```

The request function takes a path and `fetch`'s `RequestInit`. It also carries
`request.url`, where the server listens, which a WebSocket client needs.

| Option | Default | |
| --- | --- | --- |
| `hostname` | Bun's default | the address to listen on |

Bun listens on both IPv4 and IPv6 by default, and reports a client that
connects over IPv4 as `::ffff:127.0.0.1`. To test code that compares an address
against `127.0.0.1`, listen on IPv4: `serve(app, { hostname: "127.0.0.1" })`.

`stopServers()` stops every server `serve` started that is still running. Under
`bun test` this is done for you; outside the test runner, `afterAll` is not
available and the caller owns the lifetime.

### request.client

`request.client(options?)` returns a client with its own headers and a cookie
jar, for a test that signs in and then acts as that user. Make one per test, so
one test's session does not reach the next.

```ts twoslash
import { expect, test } from "bun:test";
import { createApp, route } from "@tetsujs/core";
import { serve } from "@tetsujs/core/testing";

const app = createApp({
  routes: [
    route({ method: "POST", path: "/session", handler: (ctx) => {
      ctx.out.cookies.set("session", "abc");
      return { ok: true };
    } }),
    route({ method: "GET", path: "/me", handler: (ctx) => ({ session: ctx.req.cookies?.get("session") }) }),
  ],
});
// ---cut---
const request = serve(app);

test("keeps the session", async () => {
  const client = request.client({ headers: { "x-real-ip": "10.0.0.7" } });

  await client("/session", { method: "POST", json: {} });

  expect((await client("/me")).status).toBe(200);
  expect(client.cookies.get("session")).toBeDefined();
});
```

The jar does what a browser does, where it matters to a test of one server:

- It keeps every cookie a response sets, sends each back where its `Path`
  matches, and forgets it when a response deletes it or lets it expire.
- A signed cookie is held as it arrived, signature included: the client has no
  secret.
- `json` sends a value as JSON. `body` sends what it is given, a malformed body
  included. The two do not go together.
- A header set to `null` is not sent at all, even if the client's defaults or
  its cookies would send it: `{ cookie: null }` is a request without the jar.
- A redirect is returned, not followed, so the cookie it sets is kept. Pass
  `redirect: "follow"` to follow one anyway; cookies set before the last
  response are then lost.

`client.cookies` reads and changes the jar: `get(name)`, `set(name, value,
attributes?)`, which plants a forged or stale value and takes a `path` that
defaults to `/`, and `delete(name)`, which forgets the name under every path.
`Domain` is ignored, since there is one host, and `Secure` cookies are sent
over `http`, because a browser treats `localhost` as a secure context.

| Client option | Default | |
| --- | --- | --- |
| `headers` | none | headers sent with every request, unless a request names the same header |

### testCtx

A handler keeps its types, so a unit test can call it directly with a context
built by `testCtx(parts, options?)`. There is no server and no HTTP. What the
handler does not touch stays absent, and touching `ctx.server` throws, so a
unit test that reaches for the server says so.

```ts twoslash
import { expect, test } from "bun:test";
import { controller, route } from "@tetsujs/core";
import { testCtx } from "@tetsujs/core/testing";
import { z } from "zod";
// ---cut---
const users = controller("Users", () => ({
  get: route({
    method: "GET",
    path: "/users/:id",
    schema: { params: z.object({ id: z.coerce.number() }) },
    handler: (ctx) => ({ id: ctx.params.id }),
  }),
}));

test("returns the user", () => {
  const routes = users();

  expect(routes.get.handler(testCtx({ params: { id: 1 } }))).toEqual({ id: 1 });
});
```

`parts` are the fields of the context to set, and `req`, `out` and the route
have stand-ins unless `parts` gives them. The stand-in route is
`GET /` of the controller `"testCtx"`, so a test that asserts on `ctx.route`
passes its own.

| Option | Default | |
| --- | --- | --- |
| `cookies` | none | the application's `cookies` option, so code that signs a cookie or reads one with `signedCookie()` behaves as in the application |

```ts twoslash
import { testCtx } from "@tetsujs/core/testing";
// ---cut---
const ctx = testCtx(
  { req: new Request("http://test/", { headers: { cookie: "session=abc" } }) },
  { cookies: { secret: "test-secret", sign: ["session"] } },
);
```

### captureErrors

The framework reports on `console.error` what it cannot report to a client: an
error no `onError` hook answered, a handler breaking its response contract, a
failed stream. A suite that prints expected errors is one where an unexpected
one goes unnoticed. `captureErrors()` collects those lines instead of
printing them, so a test can assert on them.

```ts twoslash
import { describe, expect, test } from "bun:test";
import { controller, createApp, route } from "@tetsujs/core";
import { captureErrors, serve } from "@tetsujs/core/testing";
// ---cut---
const broken = controller("Broken", () => ({
  boom: route({
    method: "GET",
    path: "/boom",
    handler: () => {
      throw new Error("boom");
    },
  }),
}));

describe("an unhandled error", () => {
  const errors = captureErrors();
  const request = serve(createApp({ routes: broken() }));

  test("is reported", async () => {
    await request("/boom");

    expect(errors.lines.join("\n")).toContain("[tetsu]");
  });
});
```

Call it in the body of a `describe`, not inside a test: it installs the spy in
`beforeEach` and restores it in `afterEach`, so each test starts with an empty
capture. Logging from anywhere else still reaches the terminal.

## Links

- [Introduction](/docs/) and [Quick start](/docs/quick-start/)
- [Reference: createApp](/docs/reference/create-app/)
- [Framework error codes](/docs/reference/error-codes/)
- [Stability](/docs/more/stability/): the version policy of the `0.x` releases
- [Changelog](https://github.com/tetsujs/tetsu/blob/main/CHANGELOG.md)
- [Source of the package](https://github.com/tetsujs/tetsu/tree/main/packages/core)
