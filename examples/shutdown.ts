/**
 * Stopping without cutting requests.
 *
 * On `SIGTERM` or `SIGINT` the server stops accepting connections, lets the
 * requests in flight finish within `graceMs`, runs the closers — a pool, a
 * queue — and exits. `stopping` flips first, so a readiness probe starts
 * failing and the balancer sends no more traffic.
 *
 * This one serves itself rather than exporting the app: the shutdown needs
 * the server `Bun.serve` returns.
 *
 * ```sh
 * bun examples/shutdown.ts
 * curl localhost:3000/slow &             # takes 3 s
 * kill -TERM <pid>                       # the slow request still completes
 * ```
 *
 * @module
 */

import { createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";

class HealthController {
  constructor(private readonly stopping: () => boolean) {}

  ready = route({
    method: "GET",
    path: "/ready",
    handler: () =>
      this.stopping()
        ? Response.json({ ready: false }, { status: 503 })
        : { ready: true },
  });

  slow = route({
    method: "GET",
    path: "/slow",
    handler: async () => {
      await Bun.sleep(3_000);

      return { done: true };
    },
  });
}

const server = Bun.serve({
  ...createApp({
    routes: new HealthController(() => shutdown.stopping.aborted),
  }),
  port: Number(Bun.env.PORT ?? 3000),
});

const shutdown = onShutdownSignals(server, {
  graceMs: 10_000,
  close: [() => console.log("closing the pool")],
});

console.log(`listening on ${server.url} as pid ${process.pid}`);
