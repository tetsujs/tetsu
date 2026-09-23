/**
 * Where the framework's per-request overhead goes, in nanoseconds.
 *
 * The framework is a few hundred nanoseconds a request behind raw Bun, and
 * this ladder was built when the only HTTP benchmark could not resolve
 * that: its load generator shared the server's process, and an HTTP ladder
 * of ablated handlers came out with rungs *faster* than the ceiling. So
 * this one runs in process, where the quantity being measured is CPU per
 * request and nothing else. `http.ts` now reads the server's own processor
 * time a request, which settles differences of a few hundredths of a
 * microsecond over a real socket; this ladder remains for splitting the
 * pipeline into its parts.
 *
 * In-process measurement is the wrong tool for routing — that is Bun's and
 * only a real socket reaches it, which is why `http.ts` exists — and the
 * right tool here, because the pipeline runs the same way whatever
 * delivered the request.
 *
 * Each rung adds one thing the real pipeline does, so a rung's cost is its
 * distance from the one above:
 *
 * ```
 * inline → async → dispatch → context → nested frames → the real thing
 * ```
 *
 * To convert a rung to a throughput point: divide by the processor time a
 * request costs raw Bun in `http.ts` (about 4.7 µs). 116 ns is 2.5% of
 * that.
 *
 * Run: `bun run --cwd bench cost`
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createApp, hook, route } from "@tetsujs/core";
import { bench, run, summary } from "mitata";
import { tetsuApp } from "./shared.ts";

/**
 * A twin of the core's internal `OutgoingSettings`. Copied rather than
 * exported for a benchmark: what is being measured is the cost of
 * allocating an object with a lazy `headers` getter, and a twin measures
 * that without widening the public surface.
 */
class OutgoingSettings {
  status?: number;

  createdHeaders?: Headers;

  get headers(): Headers {
    this.createdHeaders ??= new Headers();

    return this.createdHeaders;
  }
}

const body = { pong: true };

const pathHandler = tetsuApp.routes["/ping"];

if (!pathHandler) {
  throw new Error("bench: the /ping route is gone");
}

const server = {} as never;

const params = {};

/**
 * One request, reused. Allocating a `Request` costs ~65 ns — more than
 * half of what a raw handler costs — so building one per iteration would
 * bury the quantity under the fixture. `/ping` reads no body, so the same
 * object serves every iteration.
 */
const req = Object.defineProperty(new Request("http://bench/ping"), "params", {
  value: params,
}) as never;

const methods = new Map([["GET", pathHandler]]);

const inline = (): Response => Response.json(body);

const asyncFrame = async (): Promise<Response> => Response.json(body);

const dispatched = async (request: Request): Promise<Response> => {
  const found = methods.get(request.method.toUpperCase());

  if (!found) {
    return new Response(null, { status: 405 });
  }

  return Response.json(body);
};

const withContext = async (request: Request): Promise<Response> => {
  const found = methods.get(request.method.toUpperCase());

  if (!found) {
    return new Response(null, { status: 405 });
  }

  const ctx = { req: request, server, out: new OutgoingSettings(), params };
  const progress = { ran: 0 };

  return Response.json(body, {
    status: ctx.out.status ?? 200,
    headers: progress.ran ? {} : undefined,
  });
};

/**
 * The frame the pipeline's stage functions are made of: an async function
 * awaiting the next one. Six of them stack on top of `withContext` to
 * reach the real pipeline's depth on a route with no hooks and no schema —
 * `execute`, three `runSlot` calls over empty chains, `validate` returning
 * on a missing schema, and `finalize`.
 *
 * They are `await`ed because the `await` is the microtask: an async
 * function nobody waits for costs almost nothing.
 */
const frame = async <T>(next: () => Promise<T>): Promise<T> => await next();

const nested = async (request: Request): Promise<Response> =>
  await frame(() =>
    frame(() =>
      frame(() => frame(() => frame(() => frame(() => withContext(request))))),
    ),
  );

summary(() => {
  bench("inline (raw ceiling)", () => inline());
  bench("+ async frame", async () => await asyncFrame());
  bench("+ method dispatch", async () => await dispatched(req));
  bench("+ context allocation", async () => await withContext(req));
  bench("+ 6 nested frames", async () => await nested(req));
  bench("tetsu /ping", async () => await pathHandler(req, server));
});

/**
 * What request-scoped context would cost, if `@tetsujs/request-id`
 * carried its id into the service layer.
 *
 * A separate comparison rather than a rung of the ladder above: an
 * `AsyncLocalStorage` is not something the pipeline does, it is something
 * an application might ask a package to do, and the question is only
 * whether the answer is affordable.
 *
 * Three variants of one route, so the cost of the store is not confused
 * with the cost of having a hook at all:
 *
 * - the bare route, the same shape the ladder ends on;
 * - the route with a hook that does nothing;
 * - the route with a hook that enters a store, which is the real proposal.
 *
 * The fourth reads the store back the way a service would. `enterWith` is
 * measured rather than `run()` because it is the form that needs no
 * wrapper around the rest of the pipeline — a hook returns, and everything
 * after it is already inside.
 */
const store = new AsyncLocalStorage<{ requestId: string }>();

const idle = hook.beforeParse(() => undefined);

const enter = hook.beforeParse(() => {
  store.enterWith({ requestId: "r-1" });
});

/** Compiles one `/ping` that differs only in the hooks it carries. */
function pinging(hooks?: { beforeParse: [typeof idle | typeof enter] }) {
  const app = createApp({
    routes: [
      route({
        method: "GET",
        path: "/ping",
        ...(hooks ? { hooks } : {}),
        handler: () => ({ pong: true }),
      }),
    ],
  });

  const handler = app.routes["/ping"];

  if (!handler) {
    throw new Error("bench: the /ping route is gone");
  }

  return handler;
}

const bare = pinging();
const hooked = pinging({ beforeParse: [idle] });
const stored = pinging({ beforeParse: [enter] });

const readingStored = createApp({
  routes: [
    route({
      method: "GET",
      path: "/ping",
      hooks: { beforeParse: [enter] },
      handler: () => ({ pong: store.getStore()?.requestId ?? null }),
    }),
  ],
}).routes["/ping"];

if (!readingStored) {
  throw new Error("bench: the reading /ping route is gone");
}

summary(() => {
  bench("/ping, no hooks", async () => await bare(req, server));
  bench("+ a hook that does nothing", async () => await hooked(req, server));
  bench(
    "+ the hook enters an ALS store",
    async () => await stored(req, server),
  );
  bench(
    "+ a service reads it back",
    async () => await readingStored(req, server),
  );
});

await run();
