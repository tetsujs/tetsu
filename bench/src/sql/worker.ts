/**
 * One target of the SQL benchmark, measured in a process of its own:
 * `../sql.ts` starts it with the target's name in `BENCH_TARGET` and the
 * database's URL in `BENCH_URL`, and reads its readings, as JSON, from its
 * output.
 *
 * Before anything is timed, each operation's answer is checked against
 * the rows the database holds: a fast query that answers wrongly is not
 * fast.
 *
 * @module
 */

import { SQL } from "bun";
import type { Target } from "./targets.ts";
import { ITEMS, item, LANES, targets } from "./targets.ts";

/** What one operation of a target reads. */
export interface Reading {
  /** The median of its latencies, one operation at a time, in µs. */
  readonly p50Micros: number;

  /** Operations a second, `LANES` in flight. */
  readonly perSecond: number;

  /** Processor time an operation costs the process, in µs. */
  readonly cpuMicros: number;
}

/** The readings of a target, by operation. */
export type Readings = Record<string, Reading>;

/** How long an operation runs before it is timed, each way. */
const WARMUP_MS = 300;

/** How long an operation is timed one at a time. */
const SEQUENTIAL_MS = 1_000;

/** How long an operation is timed with `LANES` in flight. */
const CONCURRENT_MS = 2_000;

/** An operation, the `index`th started, on lane `lane`. */
type Operation = (
  target: Target,
  lane: number,
  index: number,
) => Promise<unknown>;

/**
 * The operations. A lane's transactions move a unit back and forth
 * between two accounts of its own, so that no two lanes wait on a lock.
 */
const operations: Readonly<Record<string, Operation>> = {
  "one row": (target, _, index) => target.one(BigInt((index % ITEMS) + 1)),
  "100 rows": (target, _, index) =>
    target.hundred(BigInt((index * 100) % (ITEMS - 100))),
  insert: (target, _, index) => target.insert(BigInt((index % ITEMS) + 1)),
  transaction: (target, lane, index) => {
    const first = BigInt(lane * 2 + 1);

    return index % 2 === 0
      ? target.transfer(first, first + 1n)
      : target.transfer(first + 1n, first);
  },
};

/** Throws unless `actual` is `expected`. */
function expectEqual(what: string, actual: unknown, expected: unknown): void {
  if (!Bun.deepEquals(actual, expected)) {
    throw new Error(
      `${what} answered ${Bun.inspect(actual)}, not ${Bun.inspect(expected)}`,
    );
  }
}

/** Checks each operation of `target` against the rows the database holds. */
async function check(target: Target, url: string): Promise<void> {
  expectEqual("one row", Array.from(await target.one(7n)), [item(7n)]);
  expectEqual(
    "100 rows",
    Array.from(await target.hundred(9_000n)),
    Array.from({ length: 100 }, (_, index) => item(9_001n + BigInt(index))),
  );

  const [inserted] = await target.insert(7n);

  expectEqual(
    "insert",
    typeof (inserted as { id?: unknown } | undefined)?.id,
    "bigint",
  );

  const reader = new SQL({ url, bigint: true, max: 1 });

  try {
    const balances = async () =>
      Array.from(
        await reader<
          { id: bigint; balance: bigint }[]
        >`select id, balance from accounts where id in (1, 2) order by id`,
      );
    const [first, second] = await balances();

    await target.transfer(1n, 2n);
    expectEqual("transaction", await balances(), [
      { id: 1n, balance: (first?.balance ?? 0n) - 1n },
      { id: 2n, balance: (second?.balance ?? 0n) + 1n },
    ]);
    await target.transfer(2n, 1n);
  } finally {
    await reader.close();
  }
}

/** Runs `operation` one at a time for `ms`: the latency of each, in ms. */
async function oneAtATime(
  target: Target,
  operation: Operation,
  ms: number,
): Promise<number[]> {
  const latencies: number[] = [];
  const end = performance.now() + ms;

  for (let index = 0; performance.now() < end; index += 1) {
    const started = performance.now();

    await operation(target, 0, index);
    latencies.push(performance.now() - started);
  }

  return latencies;
}

/**
 * Runs `operation` on `LANES` lanes at once for `ms`: how many ran, and
 * the processor time the process spent, in µs.
 */
async function inFlight(
  target: Target,
  operation: Operation,
  ms: number,
): Promise<{ count: number; elapsedMs: number; cpuMicros: number }> {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const end = started + ms;
  let count = 0;

  await Promise.all(
    Array.from({ length: LANES }, async (_, lane) => {
      while (performance.now() < end) {
        const index = count;

        count += 1;
        await operation(target, lane, index);
      }
    }),
  );

  const used = process.cpuUsage(cpu);

  return {
    count,
    elapsedMs: performance.now() - started,
    cpuMicros: used.user + used.system,
  };
}

/** The median of `values`. */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Measures `operation` of `target`, each way, after a warm-up. */
async function measure(target: Target, operation: Operation): Promise<Reading> {
  await oneAtATime(target, operation, WARMUP_MS);

  const latencies = await oneAtATime(target, operation, SEQUENTIAL_MS);

  await inFlight(target, operation, WARMUP_MS);

  const { count, elapsedMs, cpuMicros } = await inFlight(
    target,
    operation,
    CONCURRENT_MS,
  );

  return {
    p50Micros: Math.round(median(latencies) * 10_000) / 10,
    perSecond: Math.round(count / (elapsedMs / 1000)),
    cpuMicros: Math.round((cpuMicros / count) * 100) / 100,
  };
}

const { BENCH_TARGET: name = "", BENCH_URL: url = "" } = Bun.env;
const build = targets[name];

if (build === undefined) {
  throw new Error(`no SQL target is named ${JSON.stringify(name)}`);
}

const target = await build(url);

try {
  await check(target, url);

  const readings: Readings = {};

  for (const [operation, run] of Object.entries(operations)) {
    readings[operation] = await measure(target, run);
  }

  console.log(JSON.stringify(readings));
} finally {
  await target.close();
}
