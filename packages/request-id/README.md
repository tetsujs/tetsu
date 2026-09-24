# @tetsujs/request-id

A request id on every request and response, for the log lines and failure
reports of one request to share.

```bash
bun add @tetsujs/request-id
```

## Usage

```ts
import { requestId } from "@tetsujs/request-id";

const id = requestId();

createApp({ hooks: { beforeParse: [id] }, routes });
```

`requestId()` is one `beforeParse` hook. Every response gets an
`x-request-id` header, and `ctx.requestId` holds the id for the rest of the
request. The request logs of
[`@tetsujs/request-log`](https://github.com/tetsujs/tetsu/tree/main/packages/request-log)
and a `reportError` receiver pick it up when this hook ran before them.

## Reading the id in a handler

`requestId()` adds `ctx.requestId`. Mounted on the application it is there
at runtime, but not in a route's types — the application does not know
which routes it will hold. To have it typed, mount it on the route:

```ts
const id = requestId();

route({
  method: "GET",
  path: "/orders",
  hooks: { beforeParse: [id] },
  handler: (ctx) => logger.info({ requestId: ctx.requestId }, "listing"),
  //                                   ^? string
});
```

or declare it where it is read, with `Requires<{ requestId: string }>`, and
the compiler checks that something provides it. A hook of the application
mounted after `requestId()` sees it typed too — that is how the
`AsyncLocalStorage` recipe below works.

## Options

| `requestId()` | Default | |
| --- | --- | --- |
| `header` | `"x-request-id"` | the header the id is written to, and read from when trusted |
| `trustIncoming` | `false` | use the id the client sent; enable only behind a proxy that sets the header |
| `generate` | `crypto.randomUUID` | how a new id is made |

## Notes

- **An incoming id is not trusted by default:** it is a value a client
  chose, and trusting it lets one client stamp another's log lines.
- **Failures share the id** when they go to your logger: pass
  `reportError` to `createApp` and log `ctx?.requestId` with the error —
  see Logging in the core README.

## The id deeper than the handler

Code that never receives `ctx` — a repository several calls down — can
still read the id through `AsyncLocalStorage`. It is a few lines, so this
package leaves it to you:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { hook, type Requires } from "@tetsujs/core";

const store = new AsyncLocalStorage<{ requestId: string }>();

export const scope = hook.beforeParse((ctx: Requires<{ requestId: string }>) => {
  store.enterWith({ requestId: ctx.requestId });
});

export const current = () => store.getStore();
```

Mount `scope` after `requestId()`, on the application so that every
request has it, a `404` included:

```ts
createApp({ hooks: { beforeParse: [id, scope] }, routes });
```

The order is what the compiler checks: a hook of the application or of a
group sees what the hooks before it at the same level contributed, and
`scope` placed before `id` does not compile.

It uses `enterWith` rather than `run` because a hook is not handed the
rest of the request as a callback, and it costs about 12 ns a request.
With pino, `mixin: () => ({ ...current() })` puts the id on every line the
application writes, from wherever it writes it. The copy matters: pino
merges each line's own fields into the object `mixin` returns, so handing
it the stored object itself would carry one line's fields into every line
after it for the rest of the request. Keep the store to things like ids and
trace labels: anything a decision depends on — a user, a role — belongs in
`ctx`, where the compiler checks it is there.
