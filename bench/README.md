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

## Snapshot (Bun 1.4.2, Apple M5 Pro, 2026-09-27, 3 rounds)

Four routes, the same in every target: `GET /ping`; `GET /users/:id`
behind a hook contributing `user` and an observer after the response;
`POST /items` with a JSON body validated as `{ name: string, qty: number }`
— a hand-written Standard Schema for Tetsu and Hono, `t.Object` for Elysia,
which is what an Elysia application would write; and a `404`.

Processor time per request, µs, lower is better:

| | ping | users + 2 hooks | POST, validated | 404 |
| --- | --- | --- | --- | --- |
| raw Bun | 4.78 | 4.81 | 5.85 | 4.82 |
| **Tetsu** | **4.95** | **5.09** | **6.60** | **5.13** |
| Tetsu + TypeBox DTO | 5.07 | 5.21 | 6.80 | 5.21 |
| Hono 4.13.8 | 5.16 | 5.87 | 6.88 | 5.41 |
| Hono, `hono/quick` | 5.47 | 6.29 | 6.89 | 5.77 |
| Elysia 1.4.30 | 4.89 | 5.13 | 6.31 | 4.91 |
| Elysia 1.4.30, `aot: false` | 7.05 | 7.56 | 8.85 | 6.01 |
| Elysia 1.4.30, `precompile` | 4.90 | 5.15 | 6.30 | 4.90 |
| Elysia 2.0.0-beta.16 | 5.07 | 5.47 | 6.29 | 5.10 |
| Elysia 2 beta, bundled | 5.06 | 5.49 | 6.27 | 5.13 |
| Elysia 2 beta, AOT build | 5.03 | 5.50 | 6.29 | 5.04 |

req/s, and Tetsu's share of raw Bun:

| | ping | users + 2 hooks | POST, validated | 404 |
| --- | --- | --- | --- | --- |
| raw Bun | 213,330 | 212,342 | 174,072 | 211,614 |
| Tetsu | 206,987 (97.0%) | 202,352 (95.3%) | 156,838 (90.1%) | 200,818 (94.9%) |
| Hono | 199,173 | 177,884 | 151,442 | 191,827 |
| Elysia 1.4.30 | 211,693 | 203,316 | 164,684 | 209,272 |
| Elysia 2 beta, AOT | 205,295 | 190,217 | 164,963 | 204,880 |

p50 is 0.40–0.59 ms and p99 0.88–1.27 ms for every target except Elysia 1
with `aot: false` (up to 1.59 ms): with 96 connections in a closed loop,
latency is mostly queueing, and it ranks the targets as req/s does.

Startup and memory:

| | startup | slowest first request | idle RSS | peak RSS under load | heap after load |
| --- | --- | --- | --- | --- | --- |
| raw Bun | 3 ms | 0.28 ms | 14.3 MB | 38–53 MB | 0.2 MB |
| **Tetsu** | **5 ms** | **0.51 ms** | **21.7 MB** | **47–59 MB** | **0.6 MB** |
| Tetsu + TypeBox DTO | 39 ms | 0.53 ms | 49.4 MB | 65–75 MB | 2.1 MB |
| Hono | 6 ms | 1.17 ms | 22.1 MB | 51–60 MB | 0.7 MB |
| Elysia 1.4.30 | 24 ms | 2.15 ms | 38.3 MB | 59–72 MB | 1.5 MB |
| Elysia 1.4.30, `precompile` | 25 ms | 0.47 ms | 43.2 MB | 58–71 MB | 1.5 MB |
| Elysia 2 beta | 13 ms | 2.24 ms | 41.2 MB | 65–77 MB | 3.1 MB |
| Elysia 2 beta, bundled | 10 ms | 2.20 ms | 32.9 MB | 54–68 MB | 2.9 MB |
| Elysia 2 beta, AOT build | 15 ms | 1.16 ms | 25.2 MB | 51–61 MB | 1.7 MB |

The targets read Tetsu from its sources. The published packages are
bundled, one file per entry point, and the core idles at 14.1 MB that way
rather than the 21.7 MB above.

Reading:

- **0.17–0.75 µs a request over raw Bun**, 90–97% of its throughput;
  ahead of Hono on every route; ahead of the Elysia 2 beta on the `GET`s,
  level on the `404` and 0.31 µs behind on the validated `POST`; level with
  Elysia 1.4.30 on the `GET`s, which compiles a function per route, and
  0.22–0.29 µs behind it on the `404` and the `POST`.
- **The `404` of an application without `onError` hooks is answered
  straight away.** With such a hook it takes the error path instead, so
  the hook sees it and formats it like every other failure — about 0.2 µs
  more in process. The error path is what every failure costs: see
  [A refusal](#per-request-overhead-in-process).
- **The fastest start of the frameworks, and with Hono the least memory**,
  and no heap growth after load for any target.
- **A TypeBox DTO is the heavy part of an application that uses one:**
  nearly all of the 28 MB it adds is `import "typebox"` itself, and the
  heavier heap makes every route slightly slower, the ones without a DTO
  included. On a two-field body it loses to a hand-written check; on
  larger bodies, and against the libraries an application would use
  instead, its compiled check wins by up to 18×
  ([What validation costs](#what-validation-costs)).

## What Elysia's options do

- **`aot` in 1.x is not optional in practice.** `aot: false` costs 40–47% more
  processor time a request on the routes and 28–30% of the throughput.
- **`precompile` in 1.x** changes nothing under load; it moves compilation
  from the first request (2.15 ms) to startup (0.47 ms), for 5 MB and 1 ms.
- **2.x has no `aot` option: ahead-of-time compilation is a build plugin**
  (`elysia/plugin/aot/bun`), so `http.ts` builds that target first. It
  leaves throughput where it was and halves the first request, and it is
  what brings 2.x's memory down, from 41.2 MB to 25.2 — bundling alone
  accounts for 8 MB of that, which is why a plain bundle of the same file
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
| build a `Response` | 141–142 |
| build an `HttpError`, never thrown | 138–139 |
| throw and catch an `HttpError` | 246–247 |
| refuse by returning, through the pipeline | 237–241 |
| refuse by throwing, through the pipeline | 776–777 |

Throwing is about 3.2× the cost end to end. Building the error is not the
expensive part: unwinding is about 100 ns, and the rest is the longer
error path — the one any refusal the application's `onError` sees has to
take, returned or thrown. The rate limiter throws for that reason. The
error path is synchronous until something on it waits, as the success
path is; before it was, a refusal by throwing cost 880–892 ns.

## What the types cost

`bun run --cwd bench types` — the compiler's work for a generated
application, read from `tsc --extendedDiagnostics`. `--check` is what CI
runs: it fails when 200 routes cost more instantiations than the budget in
`src/types.ts`.

Each controller — declared with `controller()` — is a `GET` with `params`,
`query`, a status map and four hooks — one contributing, one reading
through `Requires`, an `afterResponse` observer and an `onError` mapper —
and a `POST` with a `body`; the core is read from `dist`, as a user's
compiler reads it. The application is measured mounted two ways:
`flat`, every controller straight into `createApp`, and `grouped`, each in
a group of its own with a prefix and two group hooks, the second reading
what the first contributed. Each has its budget.

| mounting | routes | types | instantiations | memory | check |
| --- | --- | --- | --- | --- | --- |
| flat | 2 | 10 648 | 27 218 | 56 MB | 0.03 s |
| flat | 200 | 30 857 | 235 422 | 83 MB | 0.12 s |
| flat | 800 | 92 057 | 866 322 | 166 MB | 0.45 s |
| grouped | 2 | 11 274 | 29 425 | 56 MB | 0.03 s |
| grouped | 200 | 34 453 | 249 212 | 88 MB | 0.14 s |
| grouped | 800 | 104 651 | 915 212 | 187 MB | 0.57 s |

TypeScript 7.0.2, 2026-09-29. A response or error hook costs about 250
instantiations — the observer and the mapper added 49 390 at 200 routes —
and several times that on TypeScript 5.7; they are in the
application because nothing measured them before. `rawBody` added about 33 instantiations a
route, the routes that do not ask for it included — the option is a type
parameter of every route. A group costs about 130 instantiations. It
cost about 1 090 when the variant was first measured — 288 115 at 200
routes, 1 084 315 and 296 MB at 800: `group()` typed its children as the
intersection of two array types, and the checker built every method of an
array for each group. The same routes in controller classes cost
198 615 instantiations at 200 routes and 740 115 at 800: every class is a
type of its own for the checker, an object a factory returns is not. Types and instantiations are the same on every
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

Tetsu's column was measured on 2026-09-23 with controller classes; the
`controller()` form above costs 12–13% less. Past a few routes Tetsu is the
cheapest of the four, and it grows linearly — about 800 instantiations a
route — where a chain grows faster, because
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
