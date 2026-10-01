---
title: "@tetsujs/request-id"
description: A request id on every request and response, shared by the log lines and failure reports of one request.
sidebar:
  order: 6
  label: "@tetsujs/request-id"
---

`@tetsujs/request-id` gives every request an id, in the context and on the
response, so the log lines and failure reports of one request can be joined.
It is one `beforeParse` hook.

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

Every response gets an `x-request-id` header, and `ctx.requestId` holds the id
for the rest of the request. The records of
[`@tetsujs/request-log`](/docs/packages/request-log/) carry it when this hook
runs before them.

## Reading the id in a handler

Mounted on the application, `ctx.requestId` is there at runtime but not in a
route's types: the application cannot type the routes it holds (see
[Context and its types](/docs/concepts/context/)). To have it typed in a
handler, mount the hook on the route:

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

Or declare it where it is read, with `Requires<{ requestId: string }>`, and the
compiler checks that something provides it. An application hook mounted after
`requestId()` sees it typed too.

## Options

| Option | Default | |
| --- | --- | --- |
| `header` | `"x-request-id"` | the header the id is written to, and read from when trusted |
| `trustIncoming` | `false` | use the id the client sent; an empty header counts as none |
| `generate` | `crypto.randomUUID` | how a new id is made |

```ts twoslash
import { requestId } from "@tetsujs/request-id";
// ---cut---
const id = requestId({ header: "x-correlation-id", trustIncoming: true });
```

Turn on `trustIncoming` only behind a proxy that overwrites the header. An
incoming id is chosen by the client, and trusting it lets one client stamp
another's log lines.

## Notes

- **Failures share the id** when you pass `reportError` to `createApp` and log
  `ctx?.requestId` with the error. See [Logging](/docs/guides/logging/).
- The package also exports the types `RequestIdOptions` and `RequestIdHook`.
  Type a hook with `ReturnType<typeof requestId>` rather than `AnyHook`, which
  erases both the slot and the `requestId` it adds to the context.

## The id deeper than the handler

Code that never receives `ctx`, such as a repository several calls down,
can read the id through `AsyncLocalStorage`, filled by a hook mounted after
`requestId()`. [Logging](/docs/guides/logging/#the-id-deeper-than-the-handler)
shows the hook and a pino `mixin` that puts the id on every line.
