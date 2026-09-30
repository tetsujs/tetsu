---
title: Health checks and shutdown
description: Liveness and readiness routes, and a shutdown that fails readiness first, drains the requests in flight and closes streams and sockets on time.
sidebar:
  order: 8
---

This guide gives an instance the two probes an orchestrator asks, and a
shutdown that lets a load balancer move its traffic elsewhere before
anything is cut. The shutdown is
[`@tetsujs/lifecycle`](/docs/packages/lifecycle/); its package page lists
every option.

## Liveness and readiness

The two probes answer different questions, and a wrong answer to each has
a different cost:

- **Liveness** — is the process working at all? A failure restarts it. It
  checks nothing but the process: if it checked the database, a database
  that is down would restart every instance at once, and none of them would
  come back healthier.
- **Readiness** — can this instance serve traffic now? A failure takes it
  out of rotation until it passes again. It checks the instance's own
  dependencies — its database pool, the cache it cannot answer without —
  and it fails while the instance is shutting down.

A controller for both, with the dependencies and the shutdown state as
its own dependencies:

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

Each check has its own deadline and they run side by side, so a check that
hangs fails alone and the probe still answers before the orchestrator's
timeout. The refusal is the framework's envelope, and its message names the
checks that failed:

```json
{ "status": 503, "message": "Not ready: database", "error": "NOT_READY" }
```

`stopping` is a function rather than a value because the shutdown's signal
exists only once the server does, and the server is built from this
controller — the next section wires it.

A readiness check is a cheap question, asked every few seconds by every
balancer: `select 1` on the pool, not a query over a table. Leave out what
this instance can serve without. A dependency every instance shares fails
every instance's check together, and the balancer is left with nowhere to
send traffic; that is the honest answer when nothing could be served, and
the wrong one for a feature that could degrade instead.

### Keeping the probes out of the way

Probes are requests like any other, and they arrive often enough to
distort whatever counts requests:

- `docs: { hidden: true }` keeps both routes out of the
  [OpenAPI document](/docs/packages/openapi/).
- A filter by `record.route` in `accessLog()`'s `write` keeps them out of
  [request logs and metrics](/docs/guides/metrics/#feeding-a-histogram).
- A rate limit mounted on the groups it protects, rather than on the
  application, leaves them uncounted.

## Stopping

`onShutdownSignals()` takes the server `Bun.serve` returned and, on
`SIGTERM` or `SIGINT`:

1. aborts `stopping`, at once;
2. keeps serving for `preStopDelayMs`;
3. aborts `draining`, stops accepting connections and waits up to
   `graceMs` for the requests in flight;
4. cuts whatever is left, waiting up to `forceMs`;
5. runs the `close` functions in order;
6. exits with `0` if everything finished cleanly, `1` if connections had
   to be cut or a closer threw.

```ts twoslash
import { controller, httpError, route } from "@tetsujs/core";

interface HealthDeps {
  readonly stopping: () => boolean;
  readonly checks: Readonly<Record<string, () => Promise<unknown>>>;
}

const healthController = controller("Health", ({ stopping }: HealthDeps) => ({
  ready: route({
    method: "GET",
    path: "/readyz",
    handler: () => {
      if (stopping()) throw httpError(503, "STOPPING");
      return "ok";
    },
  }),
}));

const ordersController = controller("Orders", (_: { orders: object }) => ({
  list: route({ method: "GET", path: "/orders", handler: () => [] }),
}));

declare const pool: { query(sql: string): Promise<unknown>; end(): Promise<void> };
declare const orders: object;
// ---cut---
import { createApp } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

const checks = { database: () => pool.query("select 1") };

const server = Bun.serve({
  ...createApp({
    routes: [
      healthController({ stopping: () => shutdown.stopping.aborted, checks }),
      ordersController({ orders }),
    ],
  }),
  port: 3000,
});

const shutdown = onShutdownSignals(server, {
  preStopDelayMs: 5_000,
  close: [() => pool.end()],
});
```

The closers run after the server has stopped, never before, so a request
still in flight does not lose the pool it is using. A closer that throws is
reported and the rest still run.

### Why the delay

A balancer keeps sending requests for a while after the signal. In
Kubernetes, `SIGTERM` and the pod's removal from the Service happen in
parallel, and the removal takes time to reach every proxy in front of the
pod. A server that stops the moment the signal lands cuts exactly the
requests still being routed to it.

So `stopping` aborts first, readiness starts failing, and the server keeps
serving for `preStopDelayMs` while the news travels; only then does it
drain. Use the delay and the failing readiness together or not at all: a
balancer that decides by its own health checks — a cloud load balancer
polling each instance — learns about the shutdown only from the failing
answer, and without one the delay postpones the same cut instead of
avoiding it.

`preStopDelayMs` is `0` by default, which is right wherever nothing has to
be told: a test, a CLI, a process nobody routes to.

## Streams and sockets

`server.stop()` waits for every request in flight, and an event stream or
a long poll never finishes on its own. Left open, it holds the stop for the
whole of `graceMs` on every deploy, and the process then exits with `1`,
its connections cut.

Close them on `draining`, which aborts when the server starts to stop,
after the delay. An [event stream](/docs/packages/sse/) takes it as
`until`:

```ts twoslash
import { onShutdownSignals } from "@tetsujs/lifecycle";
declare const server: import("bun").Server<unknown>;
declare function feed(signal: AbortSignal): AsyncGenerator<{ data: string }>;
// ---cut---
import { route } from "@tetsujs/core";
import { sse } from "@tetsujs/sse";

const { draining } = onShutdownSignals(server, { preStopDelayMs: 5_000 });

route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: draining }),
});
```

Not on `stopping`: during the delay the balancer still sends traffic here,
and a client that reconnects at once would land on this server again, to
be closed again. After it, the client reconnects to an instance that stays.

A [WebSocket](/docs/concepts/websockets/) is the same: open for as long as
its client wants, it holds every stop for `graceMs` and is then cut with
`1006`. `until` on the endpoint closes its sockets with `1001`, going away.
The endpoint is declared before the server exists, so it takes a function,
asked as each socket opens:

```ts twoslash
import { createApp } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
// ---cut---
import { ws } from "@tetsujs/core";

const chat = ws({
  path: "/chat/:room",
  until: () => shutdown.draining,
  open: (socket) => socket.subscribe(socket.data.params.room),
});

const server = Bun.serve({ ...createApp({ routes: { chat } }), port: 3000 });
const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

## The deadline

Every step runs against a deadline rather than trusting the platform to
return: Bun's `stop()` waits for as long as a client holds a WebSocket
open. With the defaults and the delay above, a shutdown takes at most
`preStopDelayMs + graceMs + forceMs` — 16 seconds — plus the closers,
which have no deadline of their own.

A second signal skips the rest of the waiting but still runs the forced
close and every closer; a third ends the process where it stands. That is
the way out of a closer that hangs, with `exit: false` too.

The exit code says how it went: `0` for a clean stop, `1` when connections
had to be cut or a closer threw. Each failure goes to the `reportError`
option — `console.error` by default — as `{ source: "shutdown", error }`,
the shape `createApp`'s receiver takes, so one function serves both.

## Kubernetes

The probes point at the routes, and the pod's grace period covers the
whole shutdown:

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: api
      readinessProbe:
        httpGet: { path: /readyz, port: 3000 }
        periodSeconds: 2
        failureThreshold: 1
      livenessProbe:
        httpGet: { path: /livez, port: 3000 }
        periodSeconds: 10
        failureThreshold: 3
```

- **`terminationGracePeriodSeconds`** is how long Kubernetes waits, from
  the moment the pod starts terminating, before it sends `SIGKILL`. Keep it above
  `preStopDelayMs + graceMs + forceMs` and the time the closers take; the
  default, 30 seconds, covers the defaults above.
- **The readiness probe** has to fail within `preStopDelayMs` for a
  balancer that reads it to hear in time: a short `periodSeconds` and a
  `failureThreshold` of one or two.
- **The liveness probe** is slower and more forgiving: a restart is the
  expensive answer, and a busy instance that misses one probe is not a
  dead one.
- **A `preStop` hook** that sleeps does the same job as `preStopDelayMs`:
  Kubernetes runs it before sending the signal, and its time counts
  against the grace period. Use one or the other, since the two add up.
  The delay in the process needs nothing in the image, where
  `exec: { command: ["sleep", "5"] }` needs a `sleep` binary that a
  minimal image or a [compiled executable](/docs/guides/deploy/) may not
  have.

Startup needs nothing from the package: open the pool and run migrations
with an `await` before `Bun.serve`, and the readiness probe fails until the
server is listening.

## Several servers

A process that serves more than one surface — the API and a
[metrics port](/docs/guides/metrics/#serving-the-registry), a public API
and an admin one — passes them all to one call:

```ts twoslash
import { createApp } from "@tetsujs/core";
declare const publicApp: ReturnType<typeof createApp>;
declare const adminApp: ReturnType<typeof createApp>;
declare const pool: { end(): Promise<void> };
// ---cut---
import { onShutdownSignals } from "@tetsujs/lifecycle";

const api = Bun.serve({ ...publicApp, port: 3000 });
const admin = Bun.serve({ ...adminApp, port: 3001 });

onShutdownSignals([api, admin], { close: [() => pool.end()] });
```

They drain side by side within the one `graceMs`, and the closers run
once, after the last of them has stopped. A call per server would run the
closers twice and end the process as soon as the first server was done.

Scheduled work stops with the server the same way; see
[Background jobs](/docs/guides/background-jobs/).
