---
title: Performance
description: What Tetsu costs over raw Bun, compared with Elysia and Hono — processor time per request, startup, memory and the cost of the types — and how it is measured.
---

Tetsu adds a fraction of a microsecond of processor time per request over a
handler written for `Bun.serve` directly. This page shows the numbers and
what they do not cover. The full method and every reading are in
[`bench/README.md`](https://github.com/tetsujs/tetsu/blob/main/bench/README.md).

## Processor time per request

Four routes, the same in every target: `GET /ping`; `GET /users/:id` behind
a hook that adds `user` and an observer after the response; `POST /items`
with a validated JSON body; and a `404`. Microseconds per request, lower is
better — Bun 1.4.2 on an Apple M5 Pro, medians of three interleaved rounds
(2026-09-27):

| | ping | users + 2 hooks | POST, validated | 404 |
| --- | --- | --- | --- | --- |
| raw Bun | 4.78 | 4.81 | 5.85 | 4.82 |
| **Tetsu** | **4.95** | **5.09** | **6.60** | **5.13** |
| Elysia 1.4.30 | 4.89 | 5.13 | 6.31 | 4.91 |
| Elysia 2.0.0-beta.16 | 5.07 | 5.47 | 6.29 | 5.10 |
| Hono 4.13.8 | 5.16 | 5.87 | 6.88 | 5.41 |

Tetsu adds 0.17–0.75 µs a request over raw Bun and keeps 90–97% of its
throughput. It is ahead of Hono on every route. Against Elysia 1.4, which
compiles a function per route ahead of time, it is level on the `GET`s and
0.22–0.29 µs behind on the `404` and the validated `POST`.

Processor time is the number to compare, because it does not depend on
whether the load generators kept up. Requests per second and latency are in
the full report.

## Startup and memory

| | startup | slowest first request | idle RSS | peak RSS under load |
| --- | --- | --- | --- | --- |
| raw Bun | 3 ms | 0.28 ms | 14.3 MB | 38–53 MB |
| **Tetsu** | **5 ms** | **0.51 ms** | **21.7 MB** | **47–59 MB** |
| Hono | 6 ms | 1.17 ms | 22.1 MB | 51–60 MB |
| Elysia 1.4.30 | 24 ms | 2.15 ms | 38.3 MB | 59–72 MB |
| Elysia 2 beta | 13 ms | 2.24 ms | 41.2 MB | 65–77 MB |

The benchmark loads Tetsu from its sources. The published packages are
bundled and idle at 14.1 MB. No target grows its heap after load.

## The cost of the types

On every change, CI measures the compiler's work for a generated application
of 200 routes and fails if it goes over budget:

| routes | types | instantiations | memory | check |
| --- | --- | --- | --- | --- |
| 2 | 10 648 | 27 218 | 56 MB | 0.03 s |
| 200 | 30 857 | 235 422 | 83 MB | 0.12 s |
| 800 | 92 057 | 866 322 | 166 MB | 0.45 s |

TypeScript 7.0.2. The cost grows linearly, about 800 instantiations a route.
The same application written as one chain, the shape Elysia's and Hono's
typed clients need, costs 330–408 thousand instantiations at 200 routes and
2.75–3.04 million at 800.

## Validation

Validation goes through Standard Schema, so its cost is the library's. From
`bun run --cwd bench validators`, in nanoseconds per check:

| | Zod 4.6 | ArkType 2.2 | Valibot 1.5 | TypeBox via [`tb()`](/docs/packages/typebox/) |
| --- | --- | --- | --- | --- |
| small body, valid | 23 | 24 | 21 | **6.7** |
| 20-item body, valid | 922 | 168 | 784 | **52** |
| 20-item body, one item invalid | 1,020 | 3,260 | 936 | 21,090 |
| memory to import | +21 MB | +57 MB | +3 MB | +36 MB |

TypeBox's error path is the slowest of them: with `issues: "summary"` the
invalid body above takes 76 ns.

## Reproducing

```bash
git clone https://github.com/tetsujs/tetsu && cd tetsu
bun install
bun run --cwd bench http
```

Every target and every load generator runs in its own process. `ROUNDS=3`
interleaves rounds and reports medians; `ONLY=` picks targets.
`bun run --cwd bench types`, `validators` and `cost` run the other
measurements.

## What these numbers do not say

- They come from one machine and one level of concurrency.
- The load generator counts responses but does not check their bodies.
- The routes are small. In an application that talks to a database, the
  framework's share of each request is smaller still.
- Two runs back to back behave like two different machines. Compare targets
  within one run, with the baseline in it.
