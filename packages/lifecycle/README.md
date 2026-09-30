# @tetsujs/lifecycle

Graceful shutdown: stop accepting requests, let the ones in flight finish,
then close what the server was using.

```bash
bun add @tetsujs/lifecycle
```

## Usage

```ts
import { onShutdownSignals } from "@tetsujs/lifecycle";

const server = Bun.serve({ ...app });

onShutdownSignals(server, { close: [() => pool.end()] });
```

On `SIGTERM` or `SIGINT` this:

1. keeps serving for `preStopDelayMs` (0 by default — see
   [Behind a load balancer](#behind-a-load-balancer));
2. stops accepting connections and waits up to `graceMs` for in-flight
   requests;
3. cuts whatever is left, waiting up to `forceMs`;
4. runs the `close` functions in order;
5. exits with `0` if everything finished cleanly, `1` if connections had to
   be cut or a closer threw.

Closers run after the server has stopped, so a request still in flight
never loses the pool it is using. A closer that throws is reported and the
rest still run.

A second signal skips the rest of the waiting but still closes everything;
a third ends the process immediately — with `exit: false` too, since it is
the way out of a shutdown that hangs.

To run the sequence without signal handling, call `shutdown()`. It never
rejects:

```ts
import { shutdown } from "@tetsujs/lifecycle";

const { forced, failures } = await shutdown(server, { close: [() => pool.end()] });
```

### Several servers

A process that serves more than one surface — a public API and an admin
API, each on its own port — passes them all at once:

```ts
const api = Bun.serve({ ...publicApp, port: 3000 });
const admin = Bun.serve({ ...adminApp, port: 3001 });

onShutdownSignals([api, admin], { close: [() => pool.end()] });
```

They drain side by side within the one `graceMs`; only a server still
draining when it runs out is cut, and `forced` is `true` if any was. The
closers run once, after the last server has stopped. Calling
`onShutdownSignals` once per server instead would run the closers twice
and end the process as soon as the first server is done.

## Behind a load balancer

A balancer keeps sending requests for a while after the signal: in
Kubernetes, `SIGTERM` and the removal from the Service happen in parallel,
and the removal takes time to propagate. Stopping at once cuts exactly
those requests.

Keep serving for a few seconds, and fail the readiness check meanwhile, so
the balancer stops routing to you — the controller is in
[Health checks](#health-checks):

```ts
const checks = { database: () => pool.query("select 1") };

const server = Bun.serve({
  ...createApp({
    routes: [
      healthController({ stopping: () => shutdown.stopping.aborted, checks }),
      ordersController({ orders }),
    ],
  }),
});

const shutdown = onShutdownSignals(server, {
  preStopDelayMs: 5_000,
  close: [() => pool.end()],
});
```

Use both or neither: the delay without a failing readiness check only
postpones the cut.

### Streams and long polls

`server.stop()` waits for every request in flight, and an event stream or
a long poll is one that never finishes on its own. Left open, it holds the
stop for the whole of `graceMs` — on every deploy — and the process then
exits with `1`, its connections cut. Close them on `draining`, which fires
when the server starts to stop, after the pre-stop delay:

```ts
const { stopping, draining } = onShutdownSignals(server, { preStopDelayMs: 5_000 });

route({
  method: "GET",
  path: "/feed",
  handler: (ctx) => sse(ctx, feed, { until: draining }),
});
```

Not on `stopping`: during the delay the balancer is still sending traffic
here, and a client that reconnects at once would land on this server again,
to be closed again. After it, the client reconnects to one that stays.

A WebSocket is the same: open for as long as its client wants, it holds
every stop for `graceMs` and is then cut with `1006`. `until` on the
endpoint closes its sockets with `1001` — going away — and a client that
reconnects on it gets a server that stays. The endpoint is declared before
the server exists, so it takes a function, asked as a socket opens:

```ts
chat = ws({ path: "/chat/:room", until: () => shutdown.draining, open, message });

const server = Bun.serve({ ...app });
const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
```

### Health checks

The readiness check fails while stopping, and while something the instance
needs is not there. Each check has its own deadline and they run side by
side, so one that hangs fails alone and the probe still answers in time;
the answer says which one failed:

```ts
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

- `stopping` is a function because the signal exists only once the server
  does, and the server is built from the controller.
- Liveness checks nothing but the process: a database that is down takes
  the instance out of rotation, while a failing liveness probe would
  restart it, and every instance at once.
- `docs: { hidden: true }` keeps both out of the
  [OpenAPI document](../openapi); a filter in `write` keeps them out of
  [request logs and metrics](../request-log#metrics).

## Background jobs

`stopping` is a standard `AbortSignal`, so scheduled work can stop with the
server, and a closer can wait for a run in progress before the pool it uses
goes away:

```ts
let running: Promise<void> | undefined;

const job = Bun.cron("*/5 * * * *", async () => {
  if (running) return; // the previous run is still going

  running = sweep()
    .catch((error) => reportError({ source: "job", error }))
    .finally(() => {
      running = undefined;
    });

  await running;
});

const { stopping } = onShutdownSignals(server, {
  close: [() => running, () => pool.end()], // finish the run, then close the pool
});

stopping.addEventListener("abort", () => job.stop(), { once: true });
```

The guard keeps a slow run from overlapping the next one, and the `catch`
keeps a failed run from ending the schedule. `reportError` is the receiver
the application was given, so a failed run reaches the same logger as a
failed request — `source` takes any string:

```ts
const reportError = ({ source, error }: FailureReport) => logger.error({ err: error, source }, "tetsu");

const app = createApp({ reportError, routes });
```

## Options

| Option | Default | |
| --- | --- | --- |
| `close` | `[]` | functions run in order after the server has stopped |
| `preStopDelayMs` | `0` | how long to keep serving after the signal |
| `graceMs` | `10000` | how long in-flight requests get to finish |
| `forceMs` | `1000` | how long to wait for the forced close |
| `signals` | `["SIGTERM", "SIGINT"]` | `onShutdownSignals` only: which signals start it |
| `exit` | `true` | `onShutdownSignals` only: whether to end the process when done; a third signal ends it either way |
| `reportError` | `console.error` | `onShutdownSignals` only: receives each closer, or server `stop`, that threw, as `{ source: "shutdown", error }` — the same receiver `createApp` takes |

`onShutdownSignals` returns `{ stopping, draining, detach }`: the signal
that aborts when shutdown begins, the one that aborts when the server
starts to stop, and a function that removes the signal handlers (for
tests). `shutdown` returns `{ forced, failures }`: whether connections had
to be cut, and what a server's `stop` and the closers threw.

## Notes

- **Why not just `server.stop()`.** Bun's `stop()` waits forever while a
  client holds a WebSocket open, and earlier Bun releases never returned
  from `stop()` or `stop(true)` once the server had closed a socket
  itself. Every step here runs against a deadline instead.
- **WebSocket clients** of an endpoint without `until` see the connection
  cut with `1006` when the grace period runs out, and the stop is forced:
  give the endpoint `until: () => shutdown.draining` — see
  [Streams and long polls](#streams-and-long-polls).
- **Startup needs nothing from this package.** Open pools and run
  migrations with an `await` before `Bun.serve`.
- **Once per fleet** — a job that must run on one instance out of several —
  needs a shared lock, which this package does not provide.
