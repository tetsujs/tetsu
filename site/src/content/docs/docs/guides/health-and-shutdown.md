---
title: Health checks and shutdown
description: Liveness and readiness routes, and a shutdown that fails readiness first, drains the requests in flight and closes streams and sockets on time.
sidebar:
  order: 8
---

This guide gives an instance the two probes an orchestrator asks, and a
shutdown that lets the load balancer move traffic away before anything is
cut. The shutdown is [`@tetsujs/lifecycle`](/docs/packages/lifecycle/); its
package page lists every option.

## Liveness and readiness

- **Liveness** asks whether the process works at all. A failure restarts
  it, so it checks nothing but the process: a liveness check on the
  database would restart every instance when the database goes down.
- **Readiness** asks whether this instance can serve traffic now. A failure
  takes it out of rotation until it passes again. It checks the
  dependencies the instance cannot answer without, and it fails while the
  instance is shutting down.

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

The checks run side by side, each with its own deadline, so one that hangs
fails alone and the probe still answers in time. A refusal names the
checks that failed:

```json
{ "status": 503, "message": "Not ready: database", "error": "NOT_READY" }
```

`stopping` is a function because the shutdown signal exists only once the
server does, and the server is built from this controller. The next
section wires it.

Keep each check cheap — `select 1` on the pool, not a query over a table —
since every balancer asks every few seconds. Leave out dependencies the
instance can serve without: a shared dependency fails every instance's
check at once, and the balancer is left with nowhere to send traffic.

`docs: { hidden: true }` keeps the probes out of the
[OpenAPI document](/docs/packages/openapi/). To keep them out of
[request logs and metrics](/docs/guides/metrics/#feeding-a-histogram), skip
them by `record.route` in `accessLog()`'s `write`. Mount a rate limit on
the groups it protects rather than on the application, so the probes are
not counted against it.

## Stopping

On `SIGTERM` or `SIGINT`, `onShutdownSignals()` aborts `stopping`, so
readiness starts failing, keeps serving for `preStopDelayMs`, then aborts
`draining` and stops the server, giving the requests in flight `graceMs`
(10 seconds) to finish. It then cuts what is left within `forceMs`
(1 second), runs the `close` functions and exits. The [package page](/docs/packages/lifecycle/#usage)
lists every step and option.

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

The closers run after the server has stopped, so a request in flight does
not lose the pool it is using.

### Why the delay

In Kubernetes, `SIGTERM` and the pod's removal from the Service happen in
parallel, and the removal takes time to reach every proxy. A server that
stops the moment the signal lands cuts the requests still being routed to
it. So readiness fails first, and the server keeps serving for
`preStopDelayMs` while the balancers catch up.

Use the delay together with a failing readiness check. A balancer that
polls each instance learns about the shutdown only from the failing
answer; without it, the delay only postpones the same cut. Where nothing
has to be told — a test, a CLI — leave the delay at `0`.

### How long it takes

A shutdown takes at most `preStopDelayMs + graceMs + forceMs` — 16 seconds
with the settings above — plus the closers, which have no deadline. The
platform must wait at least that long before it kills the process; see
[Kubernetes](#kubernetes) below. A second signal skips the delay and the
grace period but still cuts what is left and runs the closers; a third
ends the process at once.

## Streams and sockets

An event stream or a long poll never finishes on its own. Left open, it
holds the stop for the whole of `graceMs`, and the process then exits with
`1`. Close it on `draining`, which aborts after the delay, when the server
starts to stop. An [event stream](/docs/packages/sse/) takes it as
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

Use `draining`, not `stopping`: during the delay the balancer still sends
traffic here, and a client that reconnects at once would land on this
server again.

A [WebSocket](/docs/concepts/websockets/) endpoint takes `until` too, and
closes its sockets with `1001`, going away. The endpoint is declared before
the server exists, so `until` is a function, called as each socket opens:

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

Without `until`, an open socket holds every stop for `graceMs` and is then
cut with `1006`.

## Kubernetes

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

- **`terminationGracePeriodSeconds`** is how long Kubernetes waits before
  it sends `SIGKILL`. Keep it above `preStopDelayMs + graceMs + forceMs`
  plus the time the closers take.
- **The readiness probe** has to fail within `preStopDelayMs`: a short
  `periodSeconds` and a `failureThreshold` of one or two.
- **The liveness probe** is slower and more forgiving: a restart is
  expensive, and a busy instance that misses one probe is not dead.
- **A `preStop` hook** that sleeps does the same job as `preStopDelayMs`,
  and the two add up, so use one or the other. `preStopDelayMs` needs
  nothing in the image; a `sleep` command needs a binary that a minimal
  image or a [compiled executable](/docs/guides/deploy/) may not have.

Startup needs nothing from the package: open the pool and run migrations
with `await` before `Bun.serve`, and readiness fails until the server
listens.

## Several servers

A process with more than one server — the API and a
[metrics port](/docs/guides/metrics/#serving-the-registry), or a public API
and an admin one — passes them all to one `onShutdownSignals` call; see
[Several servers](/docs/packages/lifecycle/#several-servers). Scheduled
work stops with the server the same way; see
[Background jobs](/docs/guides/background-jobs/).
