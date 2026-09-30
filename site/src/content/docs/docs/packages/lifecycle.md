---
title: "@tetsujs/lifecycle"
description: Graceful shutdown for a Bun server — stop accepting requests, let the ones in flight finish, then close what the server was using.
sidebar:
  order: 10
  label: "@tetsujs/lifecycle"
---

`@tetsujs/lifecycle` stops a server without cutting the requests it is still
serving: it stops accepting connections, waits for the ones in flight, cuts what
is left after a deadline, and then closes what the server was using. It works
with any `Bun.serve` server, not only a Tetsu application. The
[Health checks and shutdown](/docs/guides/health-and-shutdown/) guide puts it in
context.

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

1. keeps serving for `preStopDelayMs` (0 by default; see
   [Behind a load balancer](#behind-a-load-balancer));
2. stops accepting connections and waits up to `graceMs` for in-flight
   requests;
3. cuts whatever is left, waiting up to `forceMs`;
4. runs the `close` functions in order;
5. exits with `0` if everything finished cleanly, `1` if connections had to be
   cut or a closer or a server's `stop` threw.

Closers run after the server has stopped, so a request still in flight never
loses the pool it is using. A closer that throws is reported and the rest still
run.

A second signal skips the rest of the waiting, the pre-stop delay and the grace
period included, but still closes everything. A third ends the process
immediately, with `exit: false` too, since it is the way out of a shutdown that
hangs, such as a closer that never returns.

To run the sequence without signal handling, call `shutdown()`. It never
rejects: a server whose `stop` throws and a closer that throws are collected
into the result, because the point of the sequence is that every step runs.

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

A process that serves more than one surface, such as a public API and an admin
API on their own ports, passes them all at once:

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

They drain side by side within the one `graceMs`. Only a server still draining
when it runs out is cut, and `forced` is `true` if any was. The closers run
once, after the last server has stopped. Calling `onShutdownSignals` once per
server instead would run the closers twice and end the process as soon as the
first server is done.

## Behind a load balancer

A balancer keeps sending requests for a while after the signal. In Kubernetes,
`SIGTERM` and the removal from the Service happen in parallel, and the removal
takes time to propagate through kube-proxy, the ingress and whatever balancer
sits in front. Stopping at once cuts exactly those requests.

Keep serving for a few seconds, and fail the readiness check meanwhile, so the
balancer stops routing to you. The controller is in
[Health checks](#health-checks):

```ts twoslash
import { createApp, controller, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

declare const pool: { end(): Promise<void>; query(sql: string): Promise<unknown> };
declare const healthController: (deps: {
  stopping: () => boolean;
  checks: Readonly<Record<string, () => Promise<unknown>>>;
}) => object;
const ordersController = controller("Orders", () => ({
  list: route({ method: "GET", path: "/orders", handler: () => [] }),
}));
// ---cut---
const checks = { database: () => pool.query("select 1") };

const server = Bun.serve({
  ...createApp({
    routes: [
      healthController({ stopping: () => handle.stopping.aborted, checks }),
      ordersController(),
    ],
  }),
});

const handle = onShutdownSignals(server, {
  preStopDelayMs: 5_000,
  close: [() => pool.end()],
});
```

Use both or neither. The delay without a failing readiness check only postpones
the cut, because the balancer goes on sending traffic.

### Streams and long polls

`server.stop()` waits for every request in flight, and an event stream or a long
poll is one that never finishes on its own. Left open, it holds the stop for the
whole of `graceMs`, on every deploy, and the process then exits with `1`, its
connections cut. Close them on `draining`, which fires when the server starts to
stop, after the pre-stop delay:

```ts twoslash
import { createApp, route } from "@tetsujs/core";
import { sse, type ServerSentEvent } from "@tetsujs/sse";
import { onShutdownSignals } from "@tetsujs/lifecycle";

declare function feed(signal: AbortSignal): AsyncGenerator<ServerSentEvent, void, undefined>;
const server = Bun.serve({ ...createApp({ routes: [] }) });
// ---cut---
const { stopping, draining } = onShutdownSignals(server, { preStopDelayMs: 5_000 });

const live = route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: draining }),
});
```

Not on `stopping`: during the delay the balancer is still sending traffic here,
and a client that reconnects at once would land on this server again, to be
closed again. After it, the client reconnects to one that stays.

A WebSocket is the same. Open for as long as its client wants, it holds every
stop for `graceMs` and is then cut with `1006`. `until` on the endpoint closes
its sockets with `1001`, going away, and a client that reconnects on it gets a
server that stays. The endpoint is declared before the server exists, so it
takes a function, asked as a socket opens:

```ts twoslash
import { createApp, ws } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

const chat = ws({
  path: "/chat/:room",
  until: () => handle.draining,
  message: (socket, message) => socket.send(String(message)),
});

const server = Bun.serve({ ...createApp({ routes: [chat] }) });
const handle = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

See [WebSockets](/docs/concepts/websockets/) for the endpoint itself.

### Health checks

The readiness check fails while stopping, and while something the instance needs
is not there. Each check has its own deadline and they run side by side, so one
that hangs fails alone and the probe still answers in time. The answer says
which one failed:

```ts twoslash
import { controller, httpError, route } from "@tetsujs/core";

async function passes(check: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([check(), Bun.sleep(timeoutMs).then(() => Promise.reject())]);

    return true;
  } catch {
    return false;
  }
}

interface HealthDeps {
  readonly stopping: () => boolean;
  readonly checks: Readonly<Record<string, () => Promise<unknown>>>;
}

export const healthController = controller("Health", ({ stopping, checks }: HealthDeps) => ({
  live: route({ method: "GET", path: "/livez", docs: { hidden: true }, handler: () => "ok" }),

  ready: route({
    method: "GET",
    path: "/readyz",
    docs: { hidden: true },
    handler: async () => {
      if (stopping()) throw httpError(503, "STOPPING", "Shutting down");

      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => ({ name, ok: await passes(check, 1_000) })),
      );

      const failing = results.filter((result) => !result.ok).map((result) => result.name);

      if (failing.length > 0) throw httpError(503, "NOT_READY", `Not ready: ${failing.join(", ")}`);

      return "ok";
    },
  }),
}));
```

- `stopping` is a function because the signal exists only once the server does,
  and the server is built from the controller.
- Liveness checks nothing but the process. A database that is down takes the
  instance out of rotation, while a failing liveness probe would restart it, and
  every instance at once.
- `docs: { hidden: true }` keeps both out of the
  [OpenAPI document](/docs/packages/openapi/); a filter in `write` keeps them out
  of [request logs and metrics](/docs/packages/request-log/#metrics).

## Background jobs

`stopping` is a standard `AbortSignal`, so scheduled work can stop with the
server, and a closer can wait for a run in progress before the pool it uses goes
away:

```ts twoslash
import { createApp, type FailureReport } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

declare const pool: { end(): Promise<void> };
declare function sweep(): Promise<void>;
declare const logger: { error(fields: object, message: string): void };

const reportError = ({ source, error }: FailureReport) =>
  logger.error({ err: error, source }, "tetsu");

const app = createApp({ reportError, routes: [] });
const server = Bun.serve({ ...app });
// ---cut---
let running: Promise<void> | undefined;

const job = Bun.cron("*/5 * * * *", async () => {
  if (running) return;

  running = sweep()
    .catch((error) => reportError({ source: "job", error }))
    .finally(() => {
      running = undefined;
    });

  await running;
});

const { stopping } = onShutdownSignals(server, {
  close: [() => running, () => pool.end()],
});

stopping.addEventListener("abort", () => job.stop(), { once: true });
```

The guard keeps a slow run from overlapping the next one, the `catch` keeps a
failed run from ending the schedule, and the first closer finishes the run
before the pool closes. `reportError` is the receiver the application was
given, so a failed run reaches the same logger as a failed request. `source`
takes any string. See [Background jobs](/docs/guides/background-jobs/).

## Options

| Option | Default | |
| --- | --- | --- |
| `close` | `[]` | functions run in order after the server has stopped |
| `preStopDelayMs` | `0` | how long to keep serving after the signal |
| `graceMs` | `10000` | how long in-flight requests get to finish |
| `forceMs` | `1000` | how long to wait for the forced close |
| `signals` | `["SIGTERM", "SIGINT"]` | `onShutdownSignals` only: which signals start it |
| `exit` | `true` | `onShutdownSignals` only: whether to end the process when done; a third signal ends it either way |
| `reportError` | `console.error` | `onShutdownSignals` only: receives each closer, or server `stop`, that threw, as `{ source: "shutdown", error }`, the same receiver `createApp` takes |

`onShutdownSignals` returns `{ stopping, draining, detach }`:

- `stopping` aborts the moment a stop is asked for, before anything else
  happens. A readiness check reads it, and it composes with anything that takes
  an `AbortSignal`: a poll loop, a queue consumer, a `fetch` to an upstream that
  is no longer worth waiting for.
- `draining` aborts when the server starts to stop: after the pre-stop delay, or
  together with `stopping` when there is none.
- `detach` removes the signal handlers, for a process that outlives the server,
  a test suite mostly.

`shutdown` returns `{ forced, failures }`: whether connections had to be cut,
on any of the servers, and what a server's `stop` and the closers threw, in the
order they threw it.

The package exports the types `ShutdownOptions`, `SignalOptions`,
`ShutdownHandle`, `ShutdownResult`, `ShutdownFailure`, `Closer`, `Stoppable` and
`Servers`. Anything with a `stop` method is a `Stoppable`.

## Notes

- **Why not plain `server.stop()`.** Bun's `stop()` waits forever while a client
  holds a WebSocket open, and earlier Bun releases never returned from `stop()`
  or `stop(true)` once the server had closed a socket itself. Every step here
  runs against a deadline instead.
- **WebSocket clients** of an endpoint without `until` see the connection cut
  with `1006` when the grace period runs out, and the stop is forced. Give the
  endpoint `until: () => handle.draining`; see
  [Streams and long polls](#streams-and-long-polls).
- **Startup needs nothing from this package.** Open pools and run migrations
  with an `await` before `Bun.serve`.
- **Once per fleet,** a job that must run on one instance out of several, needs
  a shared lock, which this package does not provide.
