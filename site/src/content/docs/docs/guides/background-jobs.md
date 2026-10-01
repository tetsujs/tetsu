---
title: Background jobs
description: Scheduled work that starts and stops with the server, never overlaps itself, reports its failures and runs once per fleet when it has to.
sidebar:
  order: 9
---

This guide runs scheduled work inside the server's process — a sweep every
few minutes, a cache refreshed every few seconds — and stops it with the
server through [`@tetsujs/lifecycle`](/docs/packages/lifecycle/). There is
no jobs package: `Bun.cron` and `setInterval` do the scheduling, and the
rest is a few lines you own.

## A scheduled job

This job deletes expired sessions every five minutes. On shutdown, the
pool is closed only after a run in progress ends:

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

- **No new run starts once a shutdown begins.** `stopping` is an
  `AbortSignal` that aborts as soon as a shutdown begins, and it stops the
  job.
- **A run in progress is waited for.** Closers run in order after the
  server has stopped. The first returns the run's promise, so the pool
  closes only once the run settles. Closers have no deadline, so a long run
  checks the signal between batches and returns early.
- **A failed run does not end the process.** `Bun.cron` treats a rejected
  promise as `setTimeout` does: an unhandled rejection, which ends the
  process when nothing listens for it. The `catch` hands it to the same
  `reportError` that `createApp` was given, and the schedule goes on. See
  [Errors](/docs/concepts/errors/).
- **Runs do not overlap.** `Bun.cron` schedules the next fire only after
  the callback's promise settles, so a slow run delays the next one.

`Bun.cron` reads the expression in the system's local time unless it is
given `{ tz: "UTC" }` as a third argument. It also accepts nicknames such
as `@hourly` and `@daily`.

## An interval

A cron expression's smallest step is a minute. For work every few seconds,
use `setInterval`. It fires whether the last run finished or not, so
`running` doubles as a guard:

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

A tick that finds a run still going is skipped, so a slow upstream slows
the refresh down instead of piling up runs.

## Once per fleet

Every instance runs the schedule, so a daily report is sent once per
instance. Work that must run once needs a lock that every instance sees,
kept where the fleet's shared state lives. Put it behind a one-method
interface, so a test can pass a lock that always answers `true`:

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

The first instance to set the key runs the report; the others find it
taken and return. The lock is never released: it expires. Keep its time to
live longer than a run and shorter than the period — ten minutes against a
day here. An instance that dies mid-run leaves the lock to expire, and the
job waits for its next fire.

A Postgres advisory lock or a row with a unique key fits the same
interface. None of them guarantees the run happens: one that fails after
taking the lock is not retried until the next fire. Work that must not be
lost belongs in a queue.

## Where else a job can live

A job inside the server shares its process, its memory and its deploys.
That makes it cheap, and sometimes wrong:

- A job that must run when no server does — a nightly export on a service
  that scales to zero — belongs to the orchestrator: a Kubernetes
  `CronJob`, or `Bun.cron` with a module path and a title, which registers
  it with the operating system's scheduler.
- A job heavy enough to slow requests down — a large import, image
  processing — belongs in a worker process of its own.
- A queue consumer is a loop over a transport — Redis streams, SQS, a table
  polled with `for update skip locked` — and the framework has no opinion
  on which. It stops on the same `stopping` signal.
