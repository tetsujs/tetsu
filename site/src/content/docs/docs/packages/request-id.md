---
title: "@tetsujs/request-id"
description: A request id on every request and response, shared by the log lines and failure reports of one request.
sidebar:
  order: 6
  label: "@tetsujs/request-id"
---

`@tetsujs/request-id` gives every request an id, in the context and on the
response, so that the log lines and failure reports of one request can be
joined. It is one hook.

```bash
bun add @tetsujs/request-id
```

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();
// ---cut---
import { requestId } from "@tetsujs/request-id";

const id = requestId();

createApp({ hooks: { beforeParse: [id] }, routes });
```

`requestId()` is one `beforeParse` hook. Every response gets an `x-request-id`
header, and `ctx.requestId` holds the id for the rest of the request. The
request logs of [`@tetsujs/request-log`](/docs/packages/request-log/) and a
`reportError` receiver pick it up when this hook ran before them.

## Reading the id in a handler

`requestId()` adds `ctx.requestId`. Mounted on the application it is there at
runtime, but not in a route's types: the application does not know which routes
it will hold, for the same reason a group's hook is not typed in a handler (see
[Context and its types](/docs/concepts/context/)). To have it typed, mount it
on the route:

```ts twoslash
import { route } from "@tetsujs/core";
import { requestId } from "@tetsujs/request-id";
declare const logger: { info(fields: object, message: string): void };
// ---cut---
const id = requestId();

const list = route({
  method: "GET",
  path: "/orders",
  hooks: { beforeParse: [id] },
  handler: (ctx) => logger.info({ requestId: ctx.requestId }, "listing"),
  //                                   ^? string
});
```

or declare it where it is read, with `Requires<{ requestId: string }>`, and the
compiler checks that something provides it. A hook of the application mounted
after `requestId()` sees it typed too, which is how the `AsyncLocalStorage`
recipe [below](#the-id-deeper-than-the-handler) works.

## Options

| Option | Default | |
| --- | --- | --- |
| `header` | `"x-request-id"` | the header the id is written to, and read from when trusted |
| `trustIncoming` | `false` | use the id the client sent; enable only behind a proxy that sets the header |
| `generate` | `crypto.randomUUID` | how a new id is made |

An incoming header that is empty counts as none, and an id is generated.

```ts twoslash
import { requestId } from "@tetsujs/request-id";
// ---cut---
const id = requestId({ header: "x-correlation-id", trustIncoming: true });
```

## Notes

- **An incoming id is not trusted by default.** It is a value a client chose,
  and trusting it lets one client stamp another's log lines. Turn on
  `trustIncoming` only behind a proxy that overwrites the header.
- **Failures share the id** when they go to your logger: pass `reportError` to
  `createApp` and log `ctx?.requestId` with the error. See [Logging](/docs/guides/logging/).
- The package also exports the types `RequestIdOptions` and `RequestIdHook`.
  Read a hook's type off `requestId()` rather than annotating it with
  `AnyHook`, which would erase both the slot and what the hook adds to the
  context.

## The id deeper than the handler

Code that never receives `ctx`, such as a repository several calls down, can
still read the id through `AsyncLocalStorage`. It is a few lines, so this
package leaves it to you:

```ts twoslash
import { AsyncLocalStorage } from "node:async_hooks";
import { hook, type Requires } from "@tetsujs/core";

const store = new AsyncLocalStorage<{ requestId: string }>();

export const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
  store.enterWith({ requestId: ctx.requestId });
});

export const current = () => store.getStore();
```

Mount `scope` after `requestId()`, on the application so that every request has
it, a `404` included:

```ts twoslash
import { controller, createApp, hook, route, type Requires } from "@tetsujs/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { requestId } from "@tetsujs/request-id";

const items = controller("Items", () => ({
  list: route({ method: "GET", path: "/items", handler: () => [] }),
}));
const routes = items();

const store = new AsyncLocalStorage<{ requestId: string }>();
const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
  store.enterWith({ requestId: ctx.requestId });
});
// ---cut---
const id = requestId();

createApp({ hooks: { beforeParse: [id, scope] }, routes });
```

The order is what the compiler checks: a hook of the application or of a group
sees what the hooks before it at the same level contributed, and `scope` placed
before `id` does not compile.

It uses `enterWith` rather than `run` because a hook is not handed the rest of
the request as a callback, and it costs about 12 ns a request. With pino,
`mixin: () => ({ ...current() })` puts the id on every line the application
writes, from wherever it writes it. The copy matters: pino merges each line's
own fields into the object `mixin` returns, so handing it the stored object
itself would carry one line's fields into every line after it for the rest of
the request. Keep the store to things like ids and trace labels. Anything a
decision depends on, such as a user or a role, belongs in `ctx`, where the
compiler checks it is there.
