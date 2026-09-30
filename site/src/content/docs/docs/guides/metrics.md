---
title: Metrics
description: Request metrics for Prometheus, fed from the access log's record with prom-client and served on a port of their own.
sidebar:
  order: 7
---

This guide counts and times every request for Prometheus with
[`prom-client`](https://github.com/siimon/prom-client), feeding it from the
record `accessLog()` already writes, and serves the registry where
Prometheus can read it and the API's clients cannot.

## Why there is no metrics package

Request metrics need four facts about each request: its method, the route
that answered, its status and how long it took. `accessLog()` from
[`@tetsujs/request-log`](/docs/packages/request-log/) produces exactly
that, once per request, on every outcome — a `404` and a failure included
— and labels it the right way: by the route's template, with a request no
route answered kept apart.

What is left is which registry receives the record — `prom-client`,
OpenTelemetry, StatsD, a vendor's agent — and which buckets suit the
service. Those have no single right answer, so a package would either
choose for you or wrap every one of them. The recipe below is a dozen lines
you own instead.

## Feeding a histogram

`accessLog()` takes a `write` function, and a record handed to it can go
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

The histogram's `_count` series is the number of requests, so no counter
is needed beside it: the request rate is `rate(http_request_duration_seconds_count[5m])`
and the error rate the same, filtered by `status`.

The balancer's probes are left out by the route the record carries. They
arrive every few seconds from every balancer and every node, and would
outweigh the traffic the metrics are meant to describe — see
[Health checks and shutdown](/docs/guides/health-and-shutdown/).

To write the access log as well, call the logger in the same `write`: one
hook, one record, two destinations.

## Label by the route, not the path

`record.route` is the route as it was declared, `/users/:id`, whatever was
requested. `record.path` is what the client asked for, `/users/42`, and as
a label it makes a new series for every id — and for every path a scanner
tries. Series are what a Prometheus server pays for, so a label built from
the path grows without bound, and slowly enough to go unnoticed until it
does not.

A request no route answered has no `route`: a `404` for a path nothing
matches, a `405` for a method its path does not have, and a CORS preflight
`cors()` answered. The recipe counts
them all under one label value, `unmatched`, so they stay visible — a
spike of them is a scanner, or a client calling an endpoint that was
removed — without one series each.

`ctx.route` is available to your own hooks and handlers too, with the
controller's name and the route's field beside the path; a metric of your
own labelled with `ctx.route.path` agrees with the ones above. See
[Context fields](/docs/reference/context/).

## Buckets

A histogram counts each observation into buckets, and every bucket is a
series for every combination of labels. `prom-client`'s defaults run from
5 ms to 10 s in eleven steps; the right ones are those around the latencies
you want to tell apart, and few enough to keep the count down:

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

Thirty routes, answering with four statuses each, with seven buckets is
already close to a thousand series per instance. Keep `status` as it is —
the set of statuses a route answers with is small, and a response map
declares it — but think twice before adding a label that comes from the
request.

## What the duration measures

`durationMs` runs from `ctx.startedAt`, which the core reads before any
hook runs, to the moment the response goes to Bun. It measures the
pipeline: hooks, validation, the handler, serialization. Writing the
response to the socket is not in it, and neither is anything before the
pipeline started — TLS, the time a request waited in a proxy. The
balancer's own metrics cover those.

For a streamed response, the response goes to Bun when the stream is
handed over, so the duration ends there, not at the last event.

A request whose client left before the response was ready is recorded with
`aborted: true` and the status the server answered. To count those as
nginx does, label with `record.aborted ? 499 : record.status`; the recipe
keeps the status, so a server failing while its clients gave up still
leaves its `5xx` behind.

## Serving the registry

The registry is served by an application of its own, on a port the
balancer does not route to. Prometheus reads it, the API's clients do not,
and it stays out of the API's OpenAPI document, its access log and its rate
limits without anything having to exclude it:

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

The `metrics` application has no `accessLog()`, so a scrape is neither
logged nor measured. One [`onShutdownSignals`](/docs/packages/lifecycle/#several-servers)
stops both servers and closes the pool once, after the last of them.

`collectDefaultMetrics()` adds the process's own series — memory, CPU,
event loop lag, garbage collection. They are named `nodejs_*` although the
process is Bun: `prom-client` reads them through the Node APIs Bun
implements.

### On the API's own port

Where a second port is not an option, `/metrics` is a route of the API like
any other, kept out of the places it does not belong:

```ts twoslash
import { register } from "prom-client";
// ---cut---
import { controller, route } from "@tetsujs/core";

const metricsController = controller("Metrics", () => ({
  metrics: route({
    method: "GET",
    path: "/metrics",
    docs: { hidden: true },
    handler: async () =>
      new Response(await register.metrics(), {
        headers: { "content-type": register.contentType },
      }),
  }),
}));
```

- `docs: { hidden: true }` leaves it out of the
  [OpenAPI document](/docs/packages/openapi/). It is a statement about the
  document, not about access: the route is served as before.
- Add `/metrics` to the set of routes the `write` function skips, so a
  scrape does not measure itself.
- Mount a rate limit on the groups it protects rather than on the
  application, so the scraper is not counted against it.

Anyone who can reach the port can then read the metrics — the routes,
their traffic, the process's memory. Keep the path from the public
internet at the proxy, or guard the route with a hook that checks a token
Prometheus sends in its scrape configuration.

## Metrics of your own

A business event — an order placed, a payment refused — is counted where
it happens, in the service that does it, with a `Counter` from the same
registry. It shows up on the same `/metrics` page, and labelling it with
something from the request is subject to the same rule as above: a label is
a small, closed set, never an id.
