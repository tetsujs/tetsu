---
title: route
description: Every field of route() and ws(), the schema parts and response map, what is checked at compile time and at startup, and the signatures of controller() and group().
sidebar:
  order: 2
---

The functions that declare what an application serves: `route()` for an
HTTP endpoint, `ws()` for a WebSocket endpoint, `controller()` to name a
set of them and give them dependencies, `group()` to mount them under a
prefix with hooks.

## `route`

```ts
function route(config: RouteConfig): RouteDef
```

```ts twoslash
import { route } from "@tetsujs/core";
import { z } from "zod";
declare const orders: { create(body: { sku: string; qty: number }): { id: number; sku: string; qty: number } };
// ---cut---
const Order = z.object({ id: z.number(), sku: z.string(), qty: z.number() });

route({
  method: "POST",
  path: "/orders",
  schema: {
    body: z.object({ sku: z.string(), qty: z.number().int().min(1) }),
    response: { 201: Order },
  },
  maxBodySize: 64 * 1024,
  docs: { summary: "Place an order", tags: ["orders"] },
  handler: (ctx) => {
    ctx.out.status = 201;
    return orders.create(ctx.body);
  },
});
```

| Field | Type | Default | |
| --- | --- | --- | --- |
| `method` | `"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | required | kept as a literal in the route's type |
| `path` | string literal | required | the path, `:param` segments included |
| `handler` | `(ctx) => result` | required | `ctx` is inferred; never annotate it |
| `schema` | `SchemaConfig` | none | request parts and the response — [below](#schema) |
| `hooks` | hooks keyed by slot | none | the route's own hooks — [Hook slots](/docs/reference/hooks/) |
| `bodyType` | `"json" \| "form" \| "text" \| "stream"` | `"json"` | how the body is read |
| `maxBodySize` | `number` | the application's | this route's body limit in bytes |
| `rawBody` | `boolean` | `false` | keep the body's bytes as `ctx.rawBody` |
| `docs` | `RouteDocs` | none | documentation only — [below](#docs) |

`HEAD` and `OPTIONS` are not declared: every path answers them itself.

### `path`

- starts with `/`; no empty segment (`//`); no trailing `/` except the root
  path `/`;
- a parameter is `:name` and spans a whole segment;
- `*` only as the whole last segment;
- `{id}`, `?` and a bare `:` are refused rather than matched literally.

A literal is checked at compile time; any path is checked again when
`route()` runs.

### `schema`

Every part is optional, and an absent part is neither parsed, nor
validated, nor on `ctx`.

| Part | Validates | Adds to `ctx` |
| --- | --- | --- |
| `params` | path parameters, raw strings | `params`, the schema's output; without a schema, `params` is still there as strings |
| `query` | the query string, a repeated key as an array | `query` |
| `headers` | request headers, lower-case names | `headers` |
| `cookies` | the `cookie` header, signed cookies opened | `cookies` |
| `body` | the parsed body | `body` |
| `response` | the result | nothing; narrows what the handler may return and `ctx.out.status` |

Parts are validated in the order `params`, `query`, `headers`, `cookies`,
`body`, and all issues are collected into one `422` (or the configured
status). Any [Standard Schema](https://standardschema.dev) validator works.

`response` is a single schema or a map by status:

| Map value | Means |
| --- | --- |
| a schema | the body of that status |
| `null` | the status carries no body |
| `{ body?, headers?, cookies? }` | the body, and the headers and cookies it leaves with; without `body`, no body |

An entry key other than `body`, `headers` and `cookies` is refused when
`route()` runs. With a map, the handler may set only a declared status and
return any declared body; a status the map does not declare is refused at
runtime with a `500`. See [Responses](/docs/concepts/responses/#the-response-map).

### What the handler may return

| Return | Result |
| --- | --- |
| `undefined` | `204`, or `ctx.out.status` |
| a `Response` | sent unchecked; `ctx.out.status` ignored |
| another value | JSON through the response schema of its status; `200`, or `ctx.out.status` |
| a `ReadableStream`, generator or async iterable | compile error; `500` at runtime |

With `response`, the value must be the schema's output (or a `Response`);
with a map, any declared body, and `undefined` when a status is bodiless.

### Body

The body is read when the route declares `schema.body`, `bodyType` or
`rawBody`, and never otherwise. The route decides how it is parsed; the
`content-type` header is not consulted.

| `bodyType` | `ctx.body` before validation | Unparsable |
| --- | --- | --- |
| `"json"` | `unknown` | `400 MALFORMED_JSON` |
| `"form"` | `Record<string, string \| File \| (string \| File)[]>` | `400 MALFORMED_FORM` |
| `"text"` | `string` | — |
| `"stream"` | `ReadableStream<Uint8Array>`, counted against the limit | — |

Refused at compile time, and when `route()` runs where it applies:

- `bodyType: "stream"` with `schema.body` — there is nothing to validate a
  stream against;
- `rawBody: true` with `"form"` or `"stream"` — a form's bytes are not
  kept, and a stream is the raw body already.

### `docs`

| Field | Type | |
| --- | --- | --- |
| `summary` | `string` | |
| `description` | `string` | |
| `tags` | `readonly string[]` | |
| `deprecated` | `boolean` | stays in the document, marked |
| `hidden` | `boolean` | left out of the document; still served |
| `operationId` | `string` | in place of the controller's name joined with the field's |

Read only by [`@tetsujs/openapi`](/docs/packages/openapi/); no runtime
effect.

### `RouteDef`

What `route()` returns: the configuration, branded. Its `handler` keeps
its inferred type, so a unit test calls it with `testCtx()`. `isRoute(value)`
tells a `RouteDef` from anything else.

## `ws`

```ts
function ws(config: WsConfig): WsDef
```

| Field | Type | |
| --- | --- | --- |
| `path` | string literal | the handshake's path, same rules as a route's |
| `schema` | `{ params?, query?, headers?, message? }` | the handshake's parts, and every text frame |
| `hooks` | hooks keyed by slot | run for the handshake |
| `docs` | `{ summary?, description? }` | for the reader; socket endpoints are not in OpenAPI |
| `open` | `(socket) => unknown` | the socket is open |
| `message` | `(socket, message) => unknown` | a frame; the schema's output, or `string \| Buffer` without `schema.message` |
| `invalid` | `(socket, issues) => unknown` | a frame failed `schema.message`; without it the socket closes with `1007` |
| `close` | `(socket, code, reason) => unknown` | the socket closed |
| `drain` | `(socket) => unknown` | writable again after backpressure |
| `ping` | `(socket, data) => unknown` | a ping frame |
| `pong` | `(socket, data) => unknown` | a pong frame |
| `until` | `AbortSignal \| (() => AbortSignal \| undefined)` | closes the endpoint's sockets with `1001` when it fires |

`socket` is Bun's `ServerWebSocket`, with `data` typed as the handshake's
context minus `req`, `server`, `out`, `route` and `startedAt`. A handler's
failure is reported with `source: "websocket"`. A plain `GET` on the path
is a `426`. `isWs(value)` tells a `WsDef` from anything else. See
[WebSockets](/docs/concepts/websockets/).

## `controller`

```ts
function controller<Deps extends readonly unknown[], R extends object>(
  name: string,
  build: (...deps: Deps) => R,
): (...deps: Deps) => R
```

Returns `build`, named. Calling it with the dependencies gives an object
whose route and `ws()` fields are the controller's endpoints.

- `name` must be a non-empty string; an empty one throws.
- Two controllers of one application may not share a name — refused by
  `createApp`, since their `operationId`s would collide.
- `Parameters<typeof usersController>[0]` reads the dependencies' type
  back.
- An object that is not built by `controller()` is mounted too, named after
  its class, or unnamed for an object literal.

```ts twoslash
import { controller, route } from "@tetsujs/core";
interface Note { id: number; text: string }
interface NotesRepo { all(): Note[] }
// ---cut---
export const notesController = controller("Notes", ({ notes }: { notes: NotesRepo }) => ({
  list: route({ method: "GET", path: "/notes", handler: () => notes.all() }),
}));

type NotesDeps = Parameters<typeof notesController>[0];
```

## `group`

```ts
function group(
  prefix: string,
  config: { hooks?: GroupHooks; children: readonly object[] },
): GroupNode
```

Mounts `children` — controllers, routes, `ws()` endpoints, groups — under
`prefix`, with `hooks` run for every route below.

- `prefix` starts with `/`, is not `/` itself, has no trailing `/`, no
  `//`, no `:params`, no `*`, and none of `{`, `}`, `?`. A literal is
  checked at compile time; every prefix when `group()` runs.
- A group hook may require only what its slot guarantees and what the
  group's earlier hooks contribute; its contributions do not reach handler
  types.
- A group's hooks do not run for `404`, `405` and `OPTIONS`.
- `isGroup(value)` tells a `GroupNode` from anything else.

See [Groups and mounting](/docs/concepts/groups-and-mounting/).
