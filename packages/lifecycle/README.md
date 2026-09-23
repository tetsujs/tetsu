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
a third ends the process immediately.

To run the sequence without signal handling, call `shutdown()`. It never
rejects:

```ts
import { shutdown } from "@tetsujs/lifecycle";

const { forced, failures } = await shutdown(server, { close: [() => pool.end()] });
```

## Behind a load balancer

A balancer keeps sending requests for a while after the signal: in
Kubernetes, `SIGTERM` and the removal from the Service happen in parallel,
and the removal takes time to propagate. Stopping at once cuts exactly
those requests.

Keep serving for a few seconds, and fail the readiness check meanwhile, so
the balancer stops routing to you:

```ts
const { stopping } = onShutdownSignals(server, {
  preStopDelayMs: 5_000,
  close: [() => pool.end()],
});

ready = route({
  method: "GET",
  path: "/readyz",
  handler: () => {
    if (stopping.aborted) throw new HttpError(503);

    return { ok: true };
  },
});
```

Use both or neither: the delay without a failing readiness check only
postpones the cut.

## Background jobs

`stopping` is a standard `AbortSignal`, so scheduled work can stop with the
server, and a closer can wait for a run in progress before the pool it uses
goes away:

```ts
let running: Promise<void> | undefined;

const job = Bun.cron("*/5 * * * *", async () => {
  if (running) return; // the previous run is still going

  running = sweep()
    .catch((error) => console.error("sweep failed:", error))
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
keeps a failed run from ending the schedule.

## Options

| Option | Default | |
| --- | --- | --- |
| `close` | `[]` | functions run in order after the server has stopped |
| `preStopDelayMs` | `0` | how long to keep serving after the signal |
| `graceMs` | `10000` | how long in-flight requests get to finish |
| `forceMs` | `1000` | how long to wait for the forced close |
| `signals` | `["SIGTERM", "SIGINT"]` | `onShutdownSignals` only: which signals start it |
| `exit` | `true` | `onShutdownSignals` only: whether to end the process when done |

`onShutdownSignals` returns `{ stopping, detach }`: the signal that aborts
when shutdown begins, and a function that removes the signal handlers (for
tests). `shutdown` returns `{ forced, failures }`: whether connections had
to be cut, and what the closers threw.

## Notes

- **Why not just `server.stop()`.** Bun's `stop()` waits forever while a
  WebSocket is open, and `stop()` or `stop(true)` never resolves once the
  server has closed a socket itself. Every step here runs against a
  deadline instead.
- **WebSocket clients** see the connection close without a warning frame:
  Bun has no list of open sockets to send one to. To warn them, publish to a
  topic they subscribe to before shutting down.
- **Startup needs nothing from this package.** Open pools and run
  migrations with an `await` before `Bun.serve`.
- **Once per fleet** — a job that must run on one instance out of several —
  needs a shared lock, which this package does not provide.
