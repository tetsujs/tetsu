/**
 * Queries against Postgres: what an operation costs through
 * `@tetsujs/sql`, next to Bun.SQL alone and to Drizzle on the same client.
 *
 * The script creates a database of its own on the server `DATABASE_URL`
 * names, fills it, and drops it once done. Every target is a process of
 * its own (`sql/worker.ts`), and runs the same four operations
 * (`sql/targets.ts`): one row by its key, 100 rows in order, an insert
 * that returns its key, and a transaction of two updates. A commit on that
 * database does not wait for the disk (`synchronous_commit` is off), so
 * that a write measures the clients and the server rather than a flush.
 *
 * What is read, and why each:
 *
 * - **processor time per operation**, read by the target from its own
 *   `process.cpuUsage()` with 32 operations in flight — what the client
 *   side costs, independent of the server: the reading to compare;
 * - **operations a second** with 32 in flight on a pool of 10
 *   connections, where pipelining shows;
 * - **latency**, the median of one operation at a time: a round trip, and
 *   the client's work on the way.
 *
 * Run: `DATABASE_URL=postgres://… bun run --cwd bench sql`. `ROUNDS=3`
 * repeats the targets, each round in another order, and reports the
 * median of each reading; `ONLY=bun,tetsu` restricts it to some targets.
 * Raw readings land in `out/sql.json`.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SQL } from "bun";
import { LANES, POOL, SEED, targets } from "./sql/targets.ts";
import type { Reading, Readings } from "./sql/worker.ts";

const here = import.meta.dir;
const out = join(here, "..", "out");

const rounds = Number(Bun.env.ROUNDS ?? 1);

const only = Bun.env.ONLY?.split(",");

const server = Bun.env.DATABASE_URL;

if (server === undefined || server === "") {
  throw new Error(
    "the SQL benchmark needs a Postgres server where it may create a database: DATABASE_URL is not set",
  );
}

/** The URL of database `name` on the server `server` names. */
function urlOf(name: string): string {
  const url = new URL(server as string);

  url.pathname = `/${name}`;

  return url.href;
}

/** Runs `target` in a process of its own, and returns its readings. */
async function measure(target: string, url: string): Promise<Readings> {
  const child = Bun.spawn(["bun", join(here, "sql", "worker.ts")], {
    env: { ...process.env, BENCH_TARGET: target, BENCH_URL: url },
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) {
    throw new Error(`the target ${target} failed`);
  }

  return JSON.parse(output) as Readings;
}

/** The median of `values`. */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The median of each reading of each operation, over the rounds. */
function summarize(readings: readonly Readings[]): Readings {
  const operations = Object.keys(readings[0] ?? {});

  return Object.fromEntries(
    operations.map((operation) => {
      const of = (read: (reading: Reading) => number) =>
        median(readings.map((r) => read(r[operation] as Reading)));

      return [
        operation,
        {
          p50Micros: of((r) => r.p50Micros),
          perSecond: of((r) => r.perSecond),
          cpuMicros: of((r) => r.cpuMicros),
        },
      ];
    }),
  );
}

const chosen = Object.keys(targets).filter(
  (target) => only === undefined || only.includes(target),
);
const name = `tetsu_bench_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL({ url: server, max: 1 });
const collected = new Map<string, Readings[]>();

await admin.unsafe(`create database ${name}`);
await admin.unsafe(`alter database ${name} set synchronous_commit = off`);

try {
  const url = urlOf(name);
  const seeding = new SQL({ url, max: 1 });
  const [{ version }] =
    await seeding`select current_setting('server_version') as version`;

  await seeding.unsafe(SEED);
  await seeding.close();

  console.log(
    `bun ${Bun.version}, postgres ${version}, ${LANES} operations in flight on a pool of ${POOL}, ${rounds} round(s)\n`,
  );

  for (let round = 0; round < rounds; round += 1) {
    const order = [
      ...chosen.slice(round % chosen.length),
      ...chosen.slice(0, round % chosen.length),
    ];

    for (const target of order) {
      collected.set(target, [
        ...(collected.get(target) ?? []),
        await measure(target, url),
      ]);
      console.log(`round ${round + 1}: ${target} done`);
    }
  }
} finally {
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.close();
}

const summary = Object.fromEntries(
  [...collected].map(([target, readings]) => [target, summarize(readings)]),
);

for (const operation of Object.keys(Object.values(summary)[0] ?? {})) {
  console.log(`\n${operation}`);
  console.table(
    Object.fromEntries(
      Object.entries(summary).map(([target, readings]) => {
        const reading = readings[operation] as Reading;

        return [
          target,
          {
            "processor µs": reading.cpuMicros,
            "per second": reading.perSecond,
            "p50 µs": reading.p50Micros,
          },
        ];
      }),
    ),
  );
}

await mkdir(out, { recursive: true });
await Bun.write(
  join(out, "sql.json"),
  JSON.stringify({ rounds: Object.fromEntries(collected), summary }, null, 2),
);
