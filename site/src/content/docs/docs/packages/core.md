---
title: "@tetsujs/core"
description: The Tetsu framework itself — install, what the package exports, and the testing entry point.
sidebar:
  order: 1
  label: "@tetsujs/core"
---

`@tetsujs/core` is the framework: controllers, routes, lifecycle hooks,
validation, cookies, WebSockets and the request pipeline. It has no runtime
dependencies. This page lists what the package exports and where each part
is explained. The model itself is in [Key concepts](/docs/key-concepts/).

## Install

```bash
bun add @tetsujs/core
```

It needs Bun 1.4 or later, TypeScript 5.7 or later with `strict` on,
`@types/bun`, and `moduleResolution` set to `bundler`, `node16` or
`nodenext`. [Installation](/docs/installation/) explains each.

The package has two entry points: `@tetsujs/core` for the framework and
[`@tetsujs/core/testing`](#testing) for test helpers.

## What it exports

### Building an application

| Export | What it is | Explained in |
| --- | --- | --- |
| `createApp` | Builds the application from routes, hooks and options: the object you spread into `Bun.serve`. | [createApp](/docs/reference/create-app/) |
| `route` | Declares one route: method, path, `schema`, hooks and handler. | [Routes and handlers](/docs/concepts/routes-and-handlers/) |
| `controller` | Declares a controller: a named function from its dependencies to its routes. | [Controllers and dependencies](/docs/concepts/controllers/) |
| `group` | Puts routes and groups under a path prefix, with hooks of their own. | [Groups and mounting](/docs/concepts/groups-and-mounting/) |
| `hook` | One factory per slot: `hook.beforeParse`, `hook.beforeHandle`, `hook.onError` and the rest. | [Lifecycle hooks](/docs/concepts/lifecycle-hooks/) |
| `ws` | Declares a WebSocket endpoint. | [WebSockets](/docs/concepts/websockets/) |
| `onMount` | A symbol. A controller method under this name receives the built application, once, before `createApp` returns. | [Controllers and dependencies](/docs/concepts/controllers/) |

### Errors and failures

| Export | What it is | Explained in |
| --- | --- | --- |
| `HttpError` | An error with a status and a body. The pipeline answers with both. | [Errors](/docs/concepts/errors/) |
| `httpError` | Builds an `HttpError` with the standard envelope and an error code of your own. | [Errors](/docs/concepts/errors/) |
| `errorBody` | Builds the envelope `{ status, message, error }`, for a hook that returns its own `Response`. | [Errors](/docs/concepts/errors/) |
| `ValidationError` | The `HttpError` thrown when a request part fails its schema. It carries the `issues`. | [Validation](/docs/concepts/validation/) |
| `ResponseContractError` | Reported when a handler returns a status or body its response map does not allow. The client gets a `500`. | [Responses](/docs/concepts/responses/) |
| `reportFailure` | Passes a failure to the application's `reportError`, the way the framework does. | [Errors](/docs/concepts/errors/) |

### Schemas and cookies

| Export | What it is | Explained in |
| --- | --- | --- |
| `toJsonSchema` | Returns the JSON Schema of a Standard Schema value, or `undefined` if it has no JSON Schema support. Used by documentation tools. | [Validation](/docs/concepts/validation/) |
| `signedCookie` | Reads a signed cookie from the request before it is parsed, when `ctx.cookies` is not filled yet. | [Cookies](/docs/concepts/cookies/#signed-cookies) |

### Type guards

`isRoute`, `isGroup` and `isWs` tell whether a value was declared by
`route()`, `group()` or `ws()`. They are for code that walks a route tree,
such as a documentation generator.

### Types

Everything else is a type: the application, the context at each stage and
`Requires`, hooks and slots, routes, errors and cookies. The
[`createApp` reference](/docs/reference/create-app/#types) lists them by
area.

## Testing

`@tetsujs/core/testing` imports `bun:test`, so use it in test files only.
[Testing](/docs/guides/testing/) shows each helper in use.

| Helper | What it does |
| --- | --- |
| `serve(app, options?)` | Starts the application on a free port and returns a request function for it, with the server's address as `request.url`. Stopped when the tests around the call finish, so not to be called in `beforeAll`; `{ stop: false }` leaves the stop to `request.stop()`. |
| `request.client(options?)` | A client with default headers and a cookie jar, for a test that signs in and acts as that user. |
| `request.stop()` | Stops the server now. A request to it afterwards throws, saying what stopped it. |
| `testCtx(parts, options?)` | Builds a context for calling a handler directly, with no server. |
| `captureErrors()` | Collects what the framework logs on `console.error`, so a test can assert on it. Call it in a `describe` body, not inside a test. |
| `stopServers()` | Stops every server `serve` started that is still running. Needed only outside `bun test`. |

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

## Links

- [Introduction](/docs/) and [Quick start](/docs/quick-start/)
- [Reference: createApp](/docs/reference/create-app/)
- [Framework error codes](/docs/reference/error-codes/)
- [Stability](/docs/more/stability/): the version policy of the `0.x` releases
- [Changelog](https://github.com/tetsujs/tetsu/blob/main/CHANGELOG.md)
- [Source of the package](https://github.com/tetsujs/tetsu/tree/main/packages/core)
