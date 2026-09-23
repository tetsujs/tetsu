# Benchmarks

`bun run --cwd bench http` — throughput, latency, processor time and
memory of equivalent applications.

Every target (`src/targets/`) runs in its own process, and so does every
load generator (`src/loader.ts`: keep-alive `fetch` loops, latencies in a
10 µs histogram). A generator sharing the server's process competes with it
for the thread and hides the difference between servers. Three generators ×
32 connections saturate raw Bun on the machine below: two to four reach the
same 216–222 k req/s, six and eight fall back as they compete for cores.

What each target reports, read inside its own process:

- **req/s, p50, p99** over a 5 s window after a 1 s warm-up;
- **processor µs per request**, from `process.cpuUsage()` — the reading to
  compare, independent of whether the generators kept up. It varies between
  rounds by ±0.02 µs on a quiet machine and up to ±0.2 µs on a busy one —
  see [Comparing results](#comparing-results);
- **idle RSS** after a collection, **peak RSS** under load, and the **heap
  after the load** and a collection, where a leak would show;
- **startup** to listening, module loading included, and the **slowest
  first request** over the four routes, where lazy compilation shows.

Routing is Bun's native router for every target that uses it, and only a
real socket reaches it — which is why none of this runs in process.

`ROUNDS=3` repeats the matrix interleaved and reports medians; `ONLY=` takes
a comma-separated list of target names. Raw readings land in
`out/http.json`.

## Snapshot (Bun 1.4.2, Apple M5 Pro, 2026-09-23, 3 rounds)

Four routes, the same in every target: `GET /ping`; `GET /users/:id`
behind a hook contributing `user` and an observer after the response;
`POST /items` with a JSON body validated as `{ name: string, qty: number }`
— a hand-written Standard Schema for Tetsu and Hono, `t.Object` for Elysia,
which is what an Elysia application would write; and a `404`.

Processor time per request, µs, lower is better:

| | ping | users + 2 hooks | POST, validated | 404 |
| --- | --- | --- | --- | --- |
| raw Bun | 4.62 | 4.75 | 5.75 | 4.67 |
| **Tetsu** | **4.88** | **5.11** | **6.36** | **4.97** |
| Tetsu + TypeBox DTO | 5.23 | 5.47 | 6.89 | 5.40 |
| Hono 4.13.8 | 4.98 | 5.69 | 6.73 | 5.27 |
| Hono, `hono/quick` | 5.30 | 6.12 | 6.74 | 5.58 |
| Elysia 1.4.30 | 4.74 | 4.98 | 6.12 | 4.75 |
| Elysia 1.4.30, `aot: false` | 6.85 | 7.36 | 8.91 | 5.83 |
| Elysia 1.4.30, `precompile` | 4.75 | 4.98 | 6.15 | 4.76 |
| Elysia 2.0.0-beta.16 | 4.92 | 5.33 | 6.10 | 4.96 |
| Elysia 2 beta, bundled | 4.90 | 5.32 | 6.17 | 4.97 |
| Elysia 2 beta, AOT build | 4.87 | 5.33 | 6.09 | 4.88 |

req/s, and Tetsu's share of raw Bun:

| | ping | users + 2 hooks | POST, validated | 404 |
| --- | --- | --- | --- | --- |
| raw Bun | 220,836 | 214,229 | 176,678 | 218,429 |
| Tetsu | 211,096 (95.6%) | 202,008 (94.3%) | 162,530 (92.0%) | 207,311 (94.9%) |
| Hono | 206,790 | 183,889 | 155,127 | 196,999 |
| Elysia 1.4.30 | 218,580 | 209,225 | 170,017 | 216,844 |
| Elysia 2 beta, AOT | 212,080 | 196,528 | 170,432 | 211,640 |

p50 is 0.39–0.44 ms and p99 0.84–1.14 ms for every target except Elysia 1
with `aot: false` (up to 1.59 ms): with 96 connections in a closed loop,
latency is mostly queueing, and it ranks the targets as req/s does.

Startup and memory:

| | startup | slowest first request | idle RSS | peak RSS under load | heap after load |
| --- | --- | --- | --- | --- | --- |
| raw Bun | 3 ms | 0.27 ms | 14.3 MB | 37–53 MB | 0.2 MB |
| **Tetsu** | **5 ms** | **0.54 ms** | **20.9 MB** | **44–56 MB** | **0.6 MB** |
| Tetsu + TypeBox DTO | 38 ms | 0.55 ms | 49.9 MB | 63–72 MB | 2.1 MB |
| Hono | 6 ms | 1.15 ms | 22.6 MB | 51–62 MB | 0.7 MB |
| Elysia 1.4.30 | 22 ms | 2.11 ms | 38.0 MB | 59–71 MB | 1.5 MB |
| Elysia 1.4.30, `precompile` | 24 ms | 0.45 ms | 43.1 MB | 57–70 MB | 1.5 MB |
| Elysia 2 beta | 13 ms | 2.20 ms | 41.9 MB | 66–78 MB | 3.1 MB |
| Elysia 2 beta, bundled | 10 ms | 2.11 ms | 32.9 MB | 54–69 MB | 2.9 MB |
| Elysia 2 beta, AOT build | 14 ms | 1.15 ms | 25.1 MB | 51–63 MB | 1.7 MB |

The targets read Tetsu from its sources. The published packages are
bundled, one file per entry point, and the core idles at 13.7 MB that way
rather than the 20.9 MB above.

Reading:

- **0.26–0.61 µs a request over raw Bun**, 92–96% of its throughput; ahead
  of Hono on every route, level with the Elysia 2 beta, 0.13–0.24 µs behind
  Elysia 1.4.30, which compiles a function per route.
- **The least memory and the fastest start of the frameworks**, and no
  heap growth after load for any target.
- **A TypeBox DTO is the heavy part of an application that uses one:** 25
  MB of the 29 MB it adds is `import "typebox"` alone, and the heavier heap
  makes every route slightly slower, the ones without a DTO included. On a
  two-field body it loses to a hand-written check; on larger bodies, and
  against the libraries an application would use instead, its compiled
  check wins by up to 18× ([What validation costs](#what-validation-costs)).

## What Elysia's options do

- **`aot` in 1.x is not optional in practice.** `aot: false` costs 45% more
  processor time a request and 28% of the throughput.
- **`precompile` in 1.x** changes nothing under load; it moves compilation
  from the first request (2.11 ms) to startup (0.45 ms), for 5 MB and 2 ms.
- **2.x has no `aot` option: ahead-of-time compilation is a build plugin**
  (`elysia/plugin/aot/bun`), so `http.ts` builds that target first. It
  leaves throughput where it was and halves the first request, and it is
  what brings 2.x's memory down, from 41.9 MB to 25.1 — bundling alone
  accounts for 9 MB of that, which is why a plain bundle of the same file
  is measured next to it.
- **`precompile: true` fails on 2.0.0-beta.16** for a route with a body
  schema (`this.tb.buildResult is undefined` while compiling `POST
  /items`), with TypeBox 1.3.34, inside its supported range. The variant is
  left out until a later beta.
- **Hono's `hono/quick`** (LinearRouter) is slower on every route than the
  default SmartRouter; it trades matching speed for registration speed,
  which three routes do not show.

## What validation costs

`bun run --cwd bench validators` — each library through `~standard.validate`,
in process, on a two-field body and on an order of twenty lines; every
validator is checked to accept the valid input and reject the invalid one
before anything is timed. Nanoseconds:

| | Zod 4.6.5 | ArkType 2.2.3 | Valibot 1.5.0 | TypeBox 1.3 via `tb()` |
| --- | --- | --- | --- | --- |
| small body, valid | 23 | 24 | 21 | 6.7 |
| nested body, valid | 922 | 168 | 784 | 52 |
| nested body, one item invalid | 1,020 | 3,260 | 936 | 21,090 |
| the same, `issues: "summary"` | — | — | — | 76 |
| declaring the nested schema | 4,360 | 33,480 | 203 | 12,450 |
| resident memory to import | +21 MB | +57 MB | +3 MB | +36 MB |

TypeBox's compiled check is 3.4× Zod on the small body and 18× on the
nested one. Its error path is the other way round: 18.6 µs of the 21 a
rejected body costs are TypeBox's `Errors()`, which walks the value
uncompiled. `issues: "summary"` skips it and reports one issue for the
whole value.

## Per-request overhead in process

`bun run --cwd bench cost` measures the pipeline without a socket, in
nanoseconds per request, including the two comparisons below.

**Request-scoped context.** What an `AsyncLocalStorage` holding the request
id costs, entered from a hook and read back by a service, over three runs:

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| `/ping`, no hooks | 434.1 | 420.3 | 419.0 |
| + a hook that does nothing | 441.6 | 449.4 | 445.8 |
| + the hook enters the store | 453.9 | 452.6 | 465.8 |
| + a service reads it back | 446.1 | 469.1 | 467.6 |

Entering the store adds about 12 ns — less than the hook that carries it —
and reading it back is within noise. The whole thing is under one percent
of the processor time a request costs over a socket.

**A refusal.** `bun run --cwd bench refusal` — a hook that refuses by
returning a `Response` against one that throws an `HttpError`:

| | ns/iter |
| --- | --- |
| build a `Response` | 146–151 |
| build an `HttpError`, never thrown | 142–145 |
| throw and catch an `HttpError` | 248–255 |
| refuse by returning, through the pipeline | 368–396 |
| refuse by throwing, through the pipeline | 1160–1280 |

Throwing is 3.1–3.2× the cost end to end. Building the error is not the
expensive part; unwinding and the longer error path are. Hooks that refuse
often, like a rate limiter, return.

## What the types cost

`bun run --cwd bench types` — the compiler's work for a generated
application, read from `tsc --extendedDiagnostics`. `--check` is what CI
runs: it fails when 200 routes cost more instantiations than the budget in
`src/types.ts`.

Each controller is a `GET` with `params`, `query`, a status map and two
hooks, one of them reading through `Requires`, and a `POST` with a `body`;
the core is read from `dist`, as a user's compiler reads it.

| routes | types | instantiations | memory | check |
| --- | --- | --- | --- | --- |
| 2 | 7 205 | 18 743 | 51 MB | 0.02 s |
| 200 | 31 077 | 195 861 | 80 MB | 0.10 s |
| 800 | 103 377 | 732 561 | 165 MB | 0.36 s |

TypeScript 7.0.2, 2026-09-23. Types and instantiations are the same on every
machine for a given compiler, which is why they are the gate; memory and
time are not.

The same application in the other frameworks, written the way their typed
clients need it — one chain — with the same parts: `params`, `query`, a
`body`, a status map, a contributed `user` and a field derived from it.
Instantiations, then memory:

| routes | Tetsu | Elysia 2.0.0-beta.16 | Elysia 1.4.30 | Hono 4.13.8 |
| --- | --- | --- | --- | --- |
| 2, TS 7 | 18.7 k / 51 MB | 14.4 k / 89 MB | 12.7 k / 77 MB | 5.9 k / 67 MB |
| 200, TS 7 | 196 k / 80 MB | 408 k / 118 MB | 359 k / 102 MB | 330 k / 116 MB |
| 800, TS 7 | 733 k / 165 MB | 3.04 M / 205 MB | 2.85 M / 183 MB | 2.75 M / 271 MB |
| 200, TS 5.6 | 259 k / 156 MB | 1.37 M / 211 MB | 1.12 M / 185 MB | 686 k / 204 MB |
| 800, TS 5.6 | 979 k / 287 MB | stack overflow | stack overflow | stack overflow |

Past a few routes Tetsu is the cheapest of the four, and it grows linearly
— about 900 instantiations a route — where a chain grows faster, because
each call's type carries every route before it. On TypeScript 5.6, whose
checker runs on Node as the editor's language server does, an 800-call
chain exceeds the checker's stack in all three; controllers in an array
have no such limit. The 2-route row is the one place the others are
cheaper: the first routes build the inference machinery once, and every
later one reuses it.

## Comparing results

Two runs back to back are two different machines: the baseline drifts
between them by as much as most changes move a target. So:

- interleave rounds (`ROUNDS`), and put the baseline in the same run as a
  target of its own;
- compare processor time a request rather than req/s;
- look for a cause when a ratio improves, as much as when it regresses.
