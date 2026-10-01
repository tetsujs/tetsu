---
title: Metrics
description: Request metrics for Prometheus, fed from the access log's record with prom-client and served on a port of their own.
sidebar:
  order: 7
---

This guide counts and times every request for Prometheus with
[`prom-client`](https://github.com/siimon/prom-client), and serves the
registry on a port the API's clients cannot reach. There is no metrics
package: `accessLog()` from
[`@tetsujs/request-log`](/docs/packages/request-log/) already produces a
record for every request, and which registry and buckets suit a service is
the application's choice.

## Feeding a histogram

`accessLog()` takes a `write` function, and the record it is handed can go
to a logger, a registry, or both:

```ts twoslash
import { controller, route } from "@tetsujs/core";

const usersController = controller("Users", () => ({
  get: route({ method: "GET", path: "/users/:id", handler: (ctx) => ({ id: ctx.params.id }) }),
}));
// ---cut---
import { createApp } from "@tetsujs/core";
import { accessLog } from "@tetsujs/request-log";
import { collectDefaultMetrics, Histogram } from "prom-client";

collectDefaultMetrics();

const duration = new Histogram({
  name: "http_request_duration_seconds",
  help: "How long a request took, from arrival to response",
  labelNames: ["method", "route", "status"],
});

const probes = new Set(["/livez", "/readyz"]);

const measured = accessLog({
  write: (record) => {
    if (record.route !== undefined && probes.has(record.route)) return;

    duration.observe(
      { method: record.method, route: record.route ?? "unmatched", status: record.status },
      record.durationMs / 1000,
    );
  },
});

const app = createApp({
  hooks: { afterResponse: [measured] },
  routes: usersController(),
});
```

The histogram's `_count` series is the number of requests, so no separate
counter is needed: the request rate is
`rate(http_request_duration_seconds_count[5m])`, and the error rate is the
same filtered by `status`.

The [health probes](/docs/guides/health-and-shutdown/) are skipped: they
arrive every few seconds from every balancer and would outweigh real
traffic. To write the access log too, call the logger in the same `write`.

## Label by the route, not the path

`record.route` is the route as declared, `/users/:id`. `record.path` is
what the client asked for, `/users/42`, and as a label it creates a new
series for every id and every path a scanner tries. Prometheus pays for
every series, so a label built from the path grows without bound.

A request no route answered has no `route`: a `404`, a `405`, or a CORS
preflight that `cors()` answered. The recipe counts them all under
`unmatched`, so a spike stays visible without a series per path.

Your own hooks and handlers can read the same value as `ctx.route.path`.
See [Context fields](/docs/reference/context/).

## Buckets

Every bucket is a series for every combination of labels. `prom-client`'s
defaults run from 5 ms to 10 s in eleven steps. Pick buckets around the
latencies you want to tell apart, and few enough to keep the count down:

```ts twoslash
import { Histogram } from "prom-client";
// ---cut---
const duration = new Histogram({
  name: "http_request_duration_seconds",
  help: "How long a request took, from arrival to response",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5],
});
```

Thirty routes with four statuses each and seven buckets is already close
to a thousand series per instance. `status` is fine as a label, since a
route answers with few statuses; think twice before adding a label that
comes from the request.

## What the duration measures

`durationMs` runs from `ctx.startedAt`, read by the core before any hook,
to the moment the response is handed to Bun. It covers hooks, validation,
the handler and serialization. It does not cover writing the response to
the socket, TLS, or time spent in a proxy; the balancer's metrics cover
those. For a streamed response, it ends when the stream is handed over,
not at the last event.

A request whose client left early is recorded with `aborted: true` and the
status the server answered. To count those as nginx does, label with
`record.aborted ? 499 : record.status`.

## Serving the registry

Serve the registry from an application of its own, on a port the balancer
does not route to. Prometheus can read it, the API's clients cannot, and
it stays out of the API's OpenAPI document, access log and rate limits:

```ts twoslash
import * as core from "@tetsujs/core";
import { accessLog } from "@tetsujs/request-log";

const routes = core.controller("Users", () => ({
  get: core.route({ method: "GET", path: "/users/:id", handler: (ctx) => ({ id: ctx.params.id }) }),
}))();
const measured = accessLog();
declare const pool: { end(): Promise<void> };
// ---cut---
import { controller, createApp, route } from "@tetsujs/core";
import { onShutdownSignals } from "@tetsujs/lifecycle";
import { register } from "prom-client";

const metricsController = controller("Metrics", () => ({
  metrics: route({
    method: "GET",
    path: "/metrics",
    handler: async () =>
      new Response(await register.metrics(), {
        headers: { "content-type": register.contentType },
      }),
  }),
}));

const api = Bun.serve({
  ...createApp({ hooks: { afterResponse: [measured] }, routes }),
  port: 3000,
});

const internal = Bun.serve({
  ...createApp({ routes: metricsController() }),
  port: 9464,
});

onShutdownSignals([api, internal], { close: [() => pool.end()] });
```

The metrics application has no `accessLog()`, so a scrape is neither
logged nor measured. One
[`onShutdownSignals`](/docs/packages/lifecycle/#several-servers) stops both
servers.

`collectDefaultMetrics()` adds the process's memory, CPU, event loop lag
and garbage collection. The series are named `nodejs_*` even under Bun,
because `prom-client` reads them through the Node APIs Bun implements.

### On the API's own port

Where a second port is not an option, mount the same route on the API with
`docs: { hidden: true }` to keep it out of the
[OpenAPI document](/docs/packages/openapi/), and add `/metrics` to the
`probes` set the `write` function skips. Mount a rate limit on the groups
it protects rather than on the application, so the scraper is not counted
against it. Hiding the route from the document does not restrict access:
anyone who can reach the port can read the metrics. Block the path at the
proxy, or guard the route with a hook that checks a token Prometheus sends.

## Metrics of your own

Count a business event — an order placed, a payment refused — where it
happens, with a `Counter` from the same registry. It shows up on the same
`/metrics` page. The same rule applies to its labels: a small, closed set
of values, never an id.
