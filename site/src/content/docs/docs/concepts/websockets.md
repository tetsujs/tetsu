---
title: WebSockets
description: Declaring a WebSocket endpoint with ws(), a handshake that runs the ordinary hooks, typed socket data, validated messages, and closing sockets when the server stops.
sidebar:
  order: 11
---

A WebSocket endpoint is declared like a route and lives in the same
controllers, but it is not a route: it answers no method with a body and
has no response schema. This page covers `ws()`, the handshake, what a
socket carries, how messages are validated, and how sockets are closed
when the server stops.

## Declaring an endpoint

`ws()` takes the path of the handshake, its hooks and schemas, and Bun's
own socket handlers, typed against what the handshake established:

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

The socket is Bun's own `ServerWebSocket`. `send`, `subscribe`, `publish`,
`cork` and the rest are the platform's, unwrapped; only `data` is typed by
the framework. Publish and subscribe are Bun's too.

## The handshake

The handshake is an ordinary `GET`, and it runs the ordinary pipeline:
`beforeParse` hooks, validation of `params`, `query` and `headers`, and
`beforeHandle` hooks. Authentication, rate limiting and a tenant lookup are
the same hooks as on any route, mounted the same way — on the endpoint, on
a group around it, or on the application.

A refused handshake is a normal HTTP response. A hook that throws
`HttpError(401)` answers `401` in the error envelope, through `onError`,
`beforeResponse` and `afterResponse` like any other failure, and the
client's `WebSocket` reports the connection as failed. A successful
handshake produces no response at all — the socket is the answer — so the
response hooks do not run for it; `open` is where that story continues.

A plain `GET` on the endpoint's path, one that is not a handshake, is
answered `426 UPGRADE_REQUIRED`.

## What a socket carries

`socket.data` is the handshake's context, minus what belongs to the
request that is now over: path parameters, the validated `query` and
`headers`, and everything the handshake's hooks contributed. An `auth`
hook that adds `ctx.user` gives every handler a typed `socket.data.user`.

What the pipeline owns stays behind: `req`, `server`, `out`, `route`,
`startedAt`. The request in particular is left out on purpose. A socket
outlives its handshake by minutes or hours, and holding the request would
hold its headers and body with it. A hook that needs something from the
request contributes it as a field, as `named` does above.

## Handlers

| Handler | Runs when |
| --- | --- |
| `open(socket)` | the socket is open and has its data |
| `message(socket, message)` | a frame arrived — validated, when `schema.message` is declared |
| `invalid(socket, issues)` | a frame failed `schema.message` |
| `close(socket, code, reason)` | the socket closed, with the peer's code and reason |
| `drain(socket)` | backpressure eased and the socket is writable again |
| `ping(socket, data)` | a ping frame arrived |
| `pong(socket, data)` | a pong frame arrived |

Each handler may return anything: `open: (socket) => socket.send("ready")`
compiles although `send` returns a number. A returned promise is awaited
only to catch its rejection.

A handler that throws has no response to become and no request left to
hand to `onError`. Its error goes to `reportError` with
`source: "websocket"`, and the socket lives on.

## Messages

Without `schema.message`, `message` receives the frame as Bun gives it:
`string | Buffer`.

Declaring `schema.message` says the protocol is JSON. A text frame is
parsed and checked before `message` sees it, and `message` receives the
schema's output. A frame that is not valid JSON, or not valid against the
schema, never reaches the handler:

- without `invalid`, the socket is closed with `1007`, the code the
  protocol reserves for a payload that does not fit the endpoint's
  contract, and the first issue's message as the reason;
- with `invalid`, that handler receives the issues and decides — send an
  error frame, count it, close.

Ignoring such a frame is not offered: a client sending malformed data
would have nothing to tell it so. A binary frame is refused the same way
under a message schema, since a JSON protocol has no place for one.

A validator that throws or rejects, rather than reporting issues, is the
server's failure and not the client's. The socket is closed with `1011`,
the protocol's code for an unexpected condition, and the error is reported
as `websocket`.

Frames reach `message` in the order they arrived, even when the schema
checks asynchronously: the checks run side by side, and each frame is
acted on once the ones before it were. None reaches `message` after the
socket has closed.

## Serving sockets

Bun gives a server one WebSocket handler for all its sockets, and the
application carries it as `app.websocket`. `Bun.serve({ ...app })` picks
it up with everything else. It is always present, even when nothing
declares a socket, so the application's type does not depend on whether it
happens to contain one.

Bun's server-level WebSocket options — `idleTimeout`, `maxPayloadLength`,
`backpressureLimit` — are not proxied. Spread what you need over the
handler:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const routes: object[];
// ---cut---
const app = createApp({ routes });

Bun.serve({ ...app, websocket: { ...app.websocket, idleTimeout: 30 } });
```

## Closing sockets on shutdown

`server.stop()` waits for every open socket, and a socket stays open for as
long as its client wants. Left alone, one socket holds every deploy for the
whole grace period and is then cut with `1006` and no reason.

`until` closes the endpoint's sockets with `1001` — going away — when a
signal fires, and every socket opened after it at once. The client sees a
server going away and reconnects to one that stays, and `close` runs for
each socket as for any other.

It takes a signal, or a function that returns one, asked as each socket
opens. The function is the usual form: the endpoint is declared before the
server exists, and the signal only after. With
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/), that signal is
`draining`:

```ts twoslash
import { controller, createApp, ws } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
// ---cut---
const liveController = controller("Live", () => ({
  feed: ws({
    path: "/live",
    until: () => shutdown.draining,
    open: (socket) => socket.subscribe("feed"),
  }),
}));

const server = Bun.serve({ ...createApp({ routes: liveController() }) });
const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

A socket for which the function returns nothing is not closed by it. A
function that throws is reported as `websocket`, and that socket is not
closed by it either.

## Not in the document

Socket endpoints are absent from the OpenAPI document and from the route
map a typed client is generated from: OpenAPI describes request and
response, and a socket is neither. `docs` on `ws()` takes only a `summary`
and a `description`, for the reader of the code. The handshake still
occupies the `GET` of its path in `app.entries`, marked with a `ws` field,
so a route listing shows it.
