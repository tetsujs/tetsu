---
title: WebSockets
description: Declaring a WebSocket endpoint with ws(), a handshake that runs the ordinary hooks, typed socket data, validated messages, and closing sockets when the server stops.
sidebar:
  order: 11
---

A WebSocket endpoint is declared with `ws()` and lives in the same
controllers as routes. Its handshake runs the ordinary hooks, and what they
establish becomes the socket's typed data.

## Declaring an endpoint

`ws()` takes the handshake's path, its hooks and schemas, and Bun's own
socket handlers:

```ts twoslash
import { controller, HttpError, hook, ws } from "@tetsujs/core";
import { z } from "zod";
// ---cut---
const named = hook.beforeParse((ctx) => {
  const name = new URL(ctx.req.url).searchParams.get("name");

  if (!name) throw new HttpError(401);

  return { name };
});

const ChatMessage = z.object({ text: z.string().min(1).max(500) });

export const chatController = controller("Chat", () => ({
  room: ws({
    path: "/chat/:room",
    hooks: { beforeParse: [named] },
    schema: { message: ChatMessage },
    open: (socket) => socket.subscribe(socket.data.params.room),
    message: (socket, message) => {
      socket.publish(
        socket.data.params.room,
        JSON.stringify({ from: socket.data.name, text: message.text }),
        //                                ^?
      );
    },
    close: (socket) => socket.unsubscribe(socket.data.params.room),
  }),
}));
```

The socket is Bun's own `ServerWebSocket`: `send`, `subscribe`, `publish`
and the rest are the platform's, unwrapped. Only `data` is typed by the
framework.

## The handshake

The handshake is an ordinary `GET` and runs the ordinary pipeline:
`beforeParse` hooks, validation of `params`, `query` and `headers`, and
`beforeHandle` hooks. Authentication and rate limiting are the same hooks as
on any route, mounted on the endpoint, a group or the application.

A refused handshake is a normal HTTP response. A hook that throws
`HttpError(401)` answers `401` in the error envelope, through `onError` and
the response hooks, and the client's `WebSocket` reports a failed
connection. A successful handshake has no response, so the response hooks
do not run for it.

A plain `GET` on the path that is not a handshake is answered
`426 UPGRADE_REQUIRED`.

## `socket.data`

`socket.data` is the handshake's context without the parts that belong to
the finished request: path parameters, the validated `query` and `headers`,
and every field the handshake's hooks added. An `auth` hook that adds
`ctx.user` gives every handler a typed `socket.data.user`.

`req`, `server`, `out`, `route` and `startedAt` are left out. A socket can
live for hours, and holding the request would hold its headers and body. A
hook that needs something from the request adds it as a field, as `named`
does above.

## Handlers

| Handler | Runs when |
| --- | --- |
| `open(socket)` | the socket is open and has its data |
| `message(socket, message)` | a frame arrived, validated when `schema.message` is declared |
| `invalid(socket, issues)` | a frame failed `schema.message` |
| `close(socket, code, reason)` | the socket closed, with the peer's code and reason |
| `drain(socket)` | backpressure eased and the socket is writable again |
| `ping(socket, data)` | a ping frame arrived |
| `pong(socket, data)` | a pong frame arrived |

A handler may return anything; a returned promise is awaited only to catch
its rejection. A handler that throws or rejects is reported to
`reportError` with `source: "websocket"`, and the socket stays open.

## Messages

Without `schema.message`, `message` receives the frame as Bun gives it:
`string | Buffer`.

With `schema.message`, the protocol is JSON. A text frame is parsed and
validated, and `message` receives the schema's output. A frame that is not
valid JSON or fails the schema never reaches `message`, and neither does a
binary frame:

- without `invalid`, the socket is closed with `1007` and the first issue's
  message as the reason;
- with `invalid`, that handler receives the issues and decides what to do.

A validator that throws or rejects, rather than reporting issues, is the
server's failure. The socket is closed with `1011` and the error is
reported as `websocket`.

Frames reach `message` in the order they arrived, even with an asynchronous
schema, and none arrives after the socket has closed.

## Serving sockets

Bun takes one WebSocket handler for the whole server. The application
carries it as `app.websocket`, and `Bun.serve({ ...app })` picks it up. It
is always present, even when nothing declares a socket.

Bun's server-level WebSocket options, such as `idleTimeout`,
`maxPayloadLength` and `backpressureLimit`, are not proxied. Spread the
ones you need over the handler:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({ routes });

Bun.serve({ ...app, websocket: { ...app.websocket, idleTimeout: 30 } });
```

## Closing sockets on shutdown

`server.stop()` waits for every open socket, and a socket stays open as
long as its client wants, so one idle socket can hold a deploy for the
whole grace period.

`until` closes the endpoint's sockets with `1001` (going away) when a
signal fires, and closes any socket opened after that at once. The client
reconnects to a server that stays, and `close` runs as usual. It takes a
signal, or a function that returns one, called as each socket opens. The
function is the usual form, because the endpoint is declared before the
server and its signal exist: `until: () => shutdown.draining`.

If the function returns nothing, or throws, that socket is not closed by
it; a throw is reported as `websocket`.
[Health checks and shutdown](/docs/guides/health-and-shutdown/#streams-and-sockets)
wires it to the `draining` signal of `@tetsujs/lifecycle`.

## Not in the OpenAPI document

Socket endpoints are absent from the OpenAPI document and from the typed
client's route map. `docs` on `ws()` takes only a `summary` and a
`description`. The handshake still takes the `GET` of its path in
`app.entries`, marked with a `ws` field.
