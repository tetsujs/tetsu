---
title: Background jobs
description: Scheduled work that starts and stops with the server, never overlaps itself, reports its failures and runs once per fleet when it has to.
sidebar:
  order: 9
---

This guide runs scheduled work inside the server's process: a sweep every
few minutes, a cache refreshed every few seconds. It ties the job to the
server's lifetime with [`@tetsujs/lifecycle`](/docs/packages/lifecycle/),
keeps a failed run from ending the schedule, and adds a lock for work that
must run on one instance out of several.

## Why there is no jobs package

Scheduling is the platform's: `Bun.cron` runs a function on a cron
expression, and `setInterval` on a period. What a job needs around it is a
handful of lines — start and stop with the server, wait for a run in
progress at shutdown, never overlap, catch and report a failure — and each
of them is easier to read written out than configured.

Queues are a different matter, and not the framework's either. A consumer
is a loop over a transport — Redis streams, SQS, a table polled with
`for update skip locked` — and the transport has no one right answer. A
job that fails there is a retry or a dead letter, decided by the queue,
not an HTTP error envelope. The framework's part ends where it hands the
consumer the signal to stop, the same `stopping` this guide uses.

## A scheduled job

The job below deletes expired sessions every five minutes, and the
shutdown waits for a run in progress before it closes the pool the run is
using:

```ts twoslash
import type { ReportError } from "@tetsujs/core";
import { controller, createApp, route } from "@tetsujs/core";
import type { Logger } from "pino";

declare const logger: Logger;
declare const pool: { end(): Promise<void> };
declare const sessions: { deleteExpired(options: { limit: number }): Promise<number> };

const routes = controller("Status", () => ({
  get: route({ method: "GET", path: "/status", handler: () => "ok" }),
}))();
// ---cut---
import { onShutdownSignals } from "@tetsujs/lifecycle";

const reportError: ReportError = ({ source, error }) => logger.error({ err: error, source }, "failed");

async function sweepExpired(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const deleted = await sessions.deleteExpired({ limit: 500 });

    if (deleted < 500) return;
  }
}

const server = Bun.serve({ ...createApp({ reportError, routes }), port: 3000 });

let running: Promise<void> | undefined;

const shutdown = onShutdownSignals(server, {
  reportError,
  close: [() => running, () => pool.end()],
});

const job = Bun.cron("*/5 * * * *", async () => {
  running = sweepExpired(shutdown.stopping)
    .catch((error) => {
      reportError({ source: "job", error });
    })
    .finally(() => {
      running = undefined;
    });

  await running;
});

shutdown.stopping.addEventListener("abort", () => job.stop(), { once: true });
```

Each part has a reason:

- **The job stops with the server.** `stopping` is a standard
  `AbortSignal` that aborts the moment a shutdown begins, so no new run
  starts once the instance is on its way out.
- **A run in progress is waited for.** The closers run in order after the
  server has stopped: the first returns the run's promise, and the pool is
  closed only once it settles. Closers have no deadline of their own, so a
  long run passes the signal on — `sweepExpired` checks it between batches
  and returns early, leaving the rest to the next instance.
- **A failed run is caught.** `Bun.cron` treats a rejected promise the way
  `setTimeout` does: it becomes an unhandled rejection, which ends the
  process when nothing listens for it. The `catch` turns it into a report
  and the schedule goes on.
- **Failures reach one place.** `reportError` is the receiver
  `createApp` was given, so a failed run reaches the same logger as a
  failed request and a failed closer. `source` takes any string; `"job"`
  tells it apart. See [Errors](/docs/concepts/errors/).
- **Runs do not overlap.** `Bun.cron` computes the next fire only after the
  callback settles, including the promise it returns, so a run that takes
  longer than the period delays the next one instead of running beside it.
  `running` is kept for the shutdown to wait on, not as a guard.

`Bun.cron` takes a time zone as a third argument, `{ tz: "UTC" }`; without
it the expression is read in the system's local time. It also accepts
nicknames such as `@hourly` and `@daily`.

## An interval

For work every few seconds, a cron expression is too coarse — its smallest
step is a minute. `setInterval` has no such limit, and no guard against
overlap either: it fires on time whether the last run finished or not. The
guard is the `running` variable:

```ts twoslash
import { onShutdownSignals } from "@tetsujs/lifecycle";
import type { ReportError } from "@tetsujs/core";
declare const server: import("bun").Server<unknown>;
declare const reportError: ReportError;
declare function refreshRates(): Promise<void>;
// ---cut---
let running: Promise<void> | undefined;

const shutdown = onShutdownSignals(server, { close: [() => running] });

const timer = setInterval(() => {
  if (running) return;

  running = refreshRates()
    .catch((error) => {
      reportError({ source: "rates", error });
    })
    .finally(() => {
      running = undefined;
    });
}, 10_000);

shutdown.stopping.addEventListener("abort", () => clearInterval(timer), { once: true });
```

A tick that finds a run still going is skipped rather than queued, so a
slow upstream slows the refresh down instead of piling runs on it.

## Once per fleet

Every instance runs the schedule, so a job that must happen once — a daily
report, an invoice run — runs as many times as there are instances. It
needs a lock that every instance sees, and the framework has none to
offer: the lock lives where the fleet's shared state lives.

Put it behind an interface of one method, as
[`@tetsujs/rate-limit`](/docs/packages/rate-limit/#a-shared-store) does
with its `RateLimitStore`, so the job does not depend on the store, and a
test passes a lock that always answers `true`:

```ts twoslash
declare function sendDailyReport(): Promise<void>;
// ---cut---
import { redis } from "bun";

export interface JobLock {
  acquire(name: string, ttlMs: number): Promise<boolean>;
}

export const redisLock: JobLock = {
  acquire: async (name, ttlMs) =>
    (await redis.set(`lock:${name}`, crypto.randomUUID(), "PX", String(ttlMs), "NX")) === "OK",
};

const job = Bun.cron("0 6 * * *", async () => {
  if (!(await redisLock.acquire("daily-report", 10 * 60_000))) return;

  await sendDailyReport();
});
```

Every instance fires at six; the first to set the key runs the report, and
the others find it taken and return. The lock is never released: it
expires on its own, and its time to live is what makes it work. Keep it
longer than a run and shorter than the period — ten minutes against a day
here — so a slow run is not joined by another instance, and tomorrow's
fire finds the key gone. An instance that dies mid-run leaves the lock to
expire, and the job waits for its next fire.

The same interface fits a Postgres advisory lock or a row with a unique
key. What none of them gives is a guarantee that a run happens exactly
once: a run that fails after taking the lock is not retried until the next
fire. Work that must not be lost belongs in a queue, with its retries and
its dead letters.

## Where else a job can live

A job inside the server shares its process: its memory, its event loop, its
deploys. That is usually what makes it cheap, and sometimes what makes it
wrong:

- A job that has to run when no server does — a nightly export on a
  service that scales to zero — belongs to the orchestrator: a Kubernetes
  `CronJob`, or `Bun.cron` with a module path and a title, which registers
  it with the operating system's scheduler and runs it in a process of its
  own.
- A job heavy enough to slow requests down — a large import, image
  processing — belongs in a worker process of its own, reading a queue,
  and shut down with the same `stopping` signal.
