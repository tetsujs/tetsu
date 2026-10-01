---
title: route
description: The fields of route() and ws(), the schema parts and the response map, what is refused, and the signatures of controller() and group().
sidebar:
  order: 2
---

The functions that declare what an application serves: `route()` for an
HTTP endpoint, `ws()` for a WebSocket endpoint, `controller()` to name a
set of them and give them dependencies, and `group()` to mount them under
a prefix with hooks.

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
| `method` | `"GET" \| "POST" \| "PUT" \| "PATCH" \| "DELETE"` | required | `HEAD` and `OPTIONS` are answered by every path itself |
| `path` | string literal | required | the path, `:param` segments included |
| `handler` | `(ctx) => result` | required | `ctx` is inferred; never annotate it |
| `schema` | `SchemaConfig` | none | request parts and the response, [below](#schema) |
| `hooks` | hooks keyed by slot | none | the route's own hooks, see [Hook slots](/docs/reference/hooks/) |
| `bodyType` | `"json" \| "form" \| "text" \| "stream"` | `"json"` | how the body is read |
| `maxBodySize` | `number` | the application's | this route's body limit in bytes |
| `rawBody` | `boolean` | `false` | keep the body's bytes as `ctx.rawBody` |
| `docs` | `RouteDocs` | none | documentation only, [below](#docs) |

`route()` returns a `RouteDef`: the configuration, branded. Its `handler`
keeps its inferred type, so a unit test can call it with `testCtx()`.
`isRoute(value)` tells a `RouteDef` from anything else.

### `path`

- starts with `/`; no empty segment (`//`); no trailing `/`, except the
  root path `/`;
- a parameter is `:name` and fills a whole segment;
- `*` only as the whole last segment;
- `{id}`, `?` and a bare `:` are refused, not matched literally.

A literal path is checked at compile time, and every path is checked again
when `route()` runs.

### `schema`

Every part is optional. A part without a schema is not validated. Without
one, `params` is still on `ctx` as strings and a body the route reads as
parsed; the other parts are not on `ctx`.

| Part | Validates | Adds to `ctx` |
| --- | --- | --- |
| `params` | path parameters, as strings | `params` as the schema's output; without a schema, `params` holds the strings |
| `query` | the query string; a repeated key is an array | `query` |
| `headers` | request headers, with lower-case names | `headers` |
| `cookies` | the `cookie` header, signed cookies opened | `cookies` |
| `body` | the parsed body | `body` |
| `response` | the result | nothing; it limits what the handler may return and `ctx.out.status` |

Parts are validated in the order `params`, `query`, `headers`, `cookies`,
`body`. All their issues are collected into one `422`, or the configured
status. Any [Standard Schema](https://standardschema.dev) validator works.

`response` is a single schema, or a map by status:

| Map value | Means |
| --- | --- |
| a schema | the body of that status |
| `null` | the status has no body |
| `{ body?, headers?, cookies? }` | the body, and the headers and cookies the response carries; without `body`, no body |

With a map, the handler may set only a declared status. With
`validateResponses` on, a response that leaves with an undeclared status
is a `500`. An entry key other than `body`, `headers` and `cookies` makes
`route()` throw. See
[Responses](/docs/concepts/responses/#the-response-map).

### What the handler may return

| Return | Result |
| --- | --- |
| `undefined` | `204`, or `ctx.out.status` |
| a `Response` | sent unchecked; `ctx.out.status` is ignored |
| another value | JSON, checked by the response schema of its status; `200`, or `ctx.out.status` |
| a `ReadableStream`, generator or async iterable | compile error; `500` at runtime |

With `response`, the value must be the schema's output or a `Response`.
With a map, it may be any declared body, or `undefined` when a status has
no body.

### Body

The body is read only when the route declares `schema.body`, `bodyType` or
`rawBody`. The route decides how it is parsed; the `content-type` header
is ignored.

| `bodyType` | `ctx.body` before validation | Unparsable |
| --- | --- | --- |
| `"json"` | `unknown` | `400 MALFORMED_JSON` |
| `"form"` | `Record<string, string \| File \| (string \| File)[]>` | `400 MALFORMED_FORM` |
| `"text"` | `string` | never |
| `"stream"` | `ReadableStream<Uint8Array>`, counted against the limit | never |

Two combinations are compile errors:

- `bodyType: "stream"` with `schema.body`: a stream cannot be validated;
- `rawBody: true` with `"form"` or `"stream"`: a form's bytes are not
  kept, and a stream is already the raw body. `route()` also throws on
  this one at runtime.

### `docs`

`docs` takes `summary`, `description` and `tags`, plus:

- `deprecated`: the route stays in the document, marked deprecated;
- `hidden`: the route is left out of the document and still served;
- `operationId`: replaces the default, the controller's name joined with
  the field's.

Only [`@tetsujs/openapi`](/docs/packages/openapi/) reads `docs`. It has no
runtime effect.

## `ws`

```ts
function ws(config: WsConfig): WsDef
```

| Field | Type | |
| --- | --- | --- |
| `path` | string literal | the handshake's path, checked by the same rules as a route's: a literal at compile time, every path when `ws()` runs |
| `schema` | `{ params?, query?, headers?, message? }` | the handshake's parts, and every text frame |
| `hooks` | hooks keyed by slot | run for the handshake |
| `docs` | `{ summary?, description? }` | for readers only; socket endpoints are not in OpenAPI |
| `open` | `(socket) => unknown` | the socket is open |
| `message` | `(socket, message) => unknown` | a frame arrived: the schema's output, or `string \| Buffer` without `schema.message` |
| `invalid` | `(socket, issues) => unknown` | a frame failed `schema.message`; without this handler the socket closes with `1007` |
| `close` | `(socket, code, reason) => unknown` | the socket closed |
| `drain` | `(socket) => unknown` | the socket is writable again after backpressure |
| `ping` | `(socket, data) => unknown` | a ping frame arrived |
| `pong` | `(socket, data) => unknown` | a pong frame arrived |
| `until` | `AbortSignal \| (() => AbortSignal \| undefined)` | closes the endpoint's sockets with `1001` when it fires |

`socket` is Bun's `ServerWebSocket`. Its `data` is the handshake's context
without `req`, `server`, `out`, `route` and `startedAt`. A handler's
failure is reported with `source: "websocket"`. A plain `GET` on the path
is a `426`. `isWs(value)` tells a `WsDef` from anything else. See
[WebSockets](/docs/concepts/websockets/).

## `controller`

```ts
function controller(name: string, build: (...deps) => routes): (...deps) => routes
```

Returns `build`, named. Calling it with the dependencies gives an object
whose route and `ws()` fields are the controller's endpoints.

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

- An empty `name` throws.
- Two controllers of one application may not share a name: their
  `operationId`s would collide. `createApp` refuses it.
- `Parameters<typeof notesController>[0]` is the dependencies' type.
- An object not built by `controller()` is mounted too. It is named after
  its class, or unnamed if it is an object literal.

## `group`

```ts
function group(
  prefix: string,
  config: { hooks?: GroupHooks; children: readonly object[] },
): GroupNode
```

Mounts `children` (controllers, routes, `ws()` endpoints, groups) under
`prefix`, and runs `hooks` for every route below.

- `prefix` starts with `/`, is not `/` itself, and has no trailing `/`, no
  `//`, no `:param`, no `*`, and none of `{`, `}`, `?`. A literal prefix is
  checked at compile time, and every prefix when `group()` runs.
- A group hook may require only what its slot guarantees and what the
  group's earlier hooks contribute. What it contributes is not typed in
  handlers.
- A group's hooks do not run for a `404`, a `405` or an `OPTIONS` request.
- `isGroup(value)` tells a `GroupNode` from anything else.

See [Groups and mounting](/docs/concepts/groups-and-mounting/).
