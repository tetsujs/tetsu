---
title: "@tetsujs/lifecycle"
description: Graceful shutdown for a Bun server — stop accepting requests, let the ones in flight finish, then close what the server was using.
sidebar:
  order: 10
  label: "@tetsujs/lifecycle"
---

`@tetsujs/lifecycle` stops a server without cutting the requests it is still
serving, then closes what the server was using. It works with any `Bun.serve`
server, not only a Tetsu application. The
[Health checks and shutdown](/docs/guides/health-and-shutdown/) guide puts it
in context.

```bash
bun add @tetsujs/lifecycle
```

## Usage

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const ping = controller("Ping", () => ({
  ping: route({ method: "GET", path: "/ping", handler: () => "pong" }),
}));
const app = createApp({ routes: ping() });
declare const pool: { end(): Promise<void> };
// ---cut---
import { onShutdownSignals } from "@tetsujs/lifecycle";

const server = Bun.serve({ ...app });

onShutdownSignals(server, { close: [() => pool.end()] });
```

On `SIGTERM` or `SIGINT` this:

1. aborts the `stopping` signal;
2. keeps serving for `preStopDelayMs` (`0` by default; see
   [Behind a load balancer](#behind-a-load-balancer));
3. aborts the `draining` signal, stops accepting connections and waits up to
   `graceMs` for the requests in flight;
4. cuts whatever is left, waiting up to `forceMs`;
5. runs the `close` functions in order;
6. exits with `0` if all went cleanly, or `1` if connections had to be cut or
   a closer or a server's `stop` threw.

Closers run after the server has stopped, so a request in flight never loses
the pool it is using. A closer that throws is reported, and the rest still run.

A second signal skips the pre-stop delay and the grace period, but still cuts
what is left and runs the closers. A third ends the process at once, even
with `exit: false`: it is the way out of a shutdown that hangs, such as a
closer that never returns.

To run the sequence without signal handling, call `shutdown()`. It never
rejects: failures are collected into the result.

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";

const ping = controller("Ping", () => ({
  ping: route({ method: "GET", path: "/ping", handler: () => "pong" }),
}));
const server = Bun.serve({ ...createApp({ routes: ping() }) });
declare const pool: { end(): Promise<void> };
// ---cut---
import { shutdown } from "@tetsujs/lifecycle";

const { forced, failures } = await shutdown(server, { close: [() => pool.end()] });
```

### Several servers

A process with more than one server, such as a public API and an admin API on
their own ports, passes them all at once:

```ts twoslash
import { controller, createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

const ping = controller("Ping", () => ({
  ping: route({ method: "GET", path: "/ping", handler: () => "pong" }),
}));
const publicApp = createApp({ routes: ping() });
const adminApp = createApp({ routes: ping() });
declare const pool: { end(): Promise<void> };
// ---cut---
const api = Bun.serve({ ...publicApp, port: 3000 });
const admin = Bun.serve({ ...adminApp, port: 3001 });

onShutdownSignals([api, admin], { close: [() => pool.end()] });
```

They drain side by side within one `graceMs`, and the closers run once, after
the last server has stopped. Do not call `onShutdownSignals` once per server:
the closers would run twice, and the process would exit when the first server
is done.

## Behind a load balancer

A balancer keeps sending requests for a few seconds after the signal, and
stopping at once cuts exactly those requests. Set `preStopDelayMs` and fail
the readiness check while `stopping` is aborted, so traffic moves away
before the server stops. Use both or neither: a delay without a failing
readiness check only postpones the cut.
[Health checks and shutdown](/docs/guides/health-and-shutdown/) wires the
two together.

### Streams and long polls

An event stream, a long poll or a WebSocket never finishes on its own, and
holds every stop for the whole of `graceMs`. End it on `draining`: `sse()`,
`stream()` and `ws()` take it as `until`, and a long poll passes it to what
it waits on. Use `draining`, not `stopping`: during the pre-stop delay a
client that reconnects at once would land on this server again. See
[Streams and sockets](/docs/guides/health-and-shutdown/#streams-and-sockets).

### Health checks

A readiness route fails while `stopping` is aborted, and while something
the instance needs is down. The guide has a
[health controller](/docs/guides/health-and-shutdown/#liveness-and-readiness)
to copy.

## Background jobs

`stopping` is a standard `AbortSignal`, so scheduled work can stop with the
server, and a closer can wait for a run in progress before the pool it uses
goes away. [Background jobs](/docs/guides/background-jobs/) shows both.

## Options

| Option | Default | |
| --- | --- | --- |
| `close` | `[]` | functions run in order after the server has stopped |
| `preStopDelayMs` | `0` | how long to keep serving after the signal |
| `graceMs` | `10000` | how long in-flight requests get to finish |
| `forceMs` | `1000` | how long to wait for the forced close |
| `signals` | `["SIGTERM", "SIGINT"]` | `onShutdownSignals` only: which signals start it |
| `exit` | `true` | `onShutdownSignals` only: whether to end the process when done |
| `reportError` | `console.error` | `onShutdownSignals` only: receives each failure as `{ source: "shutdown", error }`, like the `reportError` of `createApp` |

`onShutdownSignals` returns `{ stopping, draining, detach }`:

- `stopping` aborts as soon as a stop is asked for. A readiness check reads
  it, and anything that takes an `AbortSignal` can use it.
- `draining` aborts when the server starts to stop: after the pre-stop delay,
  or together with `stopping` when there is none.
- `detach` removes the signal handlers, for a process that outlives the
  server, such as a test suite.

`shutdown` returns `{ forced, failures }`: whether connections had to be cut
on any server, and what the servers' `stop` and the closers threw, in order.

The package also exports the types `ShutdownOptions`, `SignalOptions`,
`ShutdownHandle`, `ShutdownResult`, `ShutdownFailure`, `Closer`, `Stoppable`
(anything with a `stop` method) and `Servers`.

## Notes

- **Why not plain `server.stop()`.** Bun's `stop()` waits as long as a client
  holds a WebSocket open. Every step here runs against a deadline instead.
- **Startup needs nothing from this package.** Open pools and run migrations
  with an `await` before `Bun.serve`.
