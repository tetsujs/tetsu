/**
 * A load probe of `@tetsujs/sql`: many workers on one pool, for a while,
 * each running a mix of what an application does, and each answer
 * checked. It looks for what a benchmark does not: an answer handed to
 * another caller, a transaction left open, a reservation never given
 * back, a promise rejected with nobody to catch it, a pool that does not
 * close.
 *
 * The mix: a query that echoes its own marker, a burst of them at once,
 * a read by key, an insert that returns its key, a transfer between two
 * accounts in a transaction, a unit of work nesting another with
 * `atomic()` that breaks a constraint, a transaction that fails, one whose
 * failure is caught before its commit, a session of `db.connection()`
 * that sets and reads a setting, a query given up by its signal with
 * `cancel query`, a write that breaks a unique key, and a fraction written
 * to an integer column.
 *
 * Two phases run on the same pool: the mix alone, where any failure but
 * the ones the mix asks for is a fault, and the mix while the server ends
 * a backend of the pool every half second or so, where a lost connection
 * is taken as the price of it, and every other check holds.
 *
 * Checked after each phase: the accounts still hold what they held; each
 * worker's counter is what its units of work made it; its inserts are
 * there; no session of the pool is left in a transaction or running; the
 * pool still answers. At the end: `db.destroy()` resolves, and no promise
 * was rejected unhandled.
 *
 * Run: `DATABASE_URL=postgres://… bun run --cwd bench sql-load`.
 * `WORKERS` (64), `POOL` (10), `MIX_SECONDS` (60) and `KILL_SECONDS` (30)
 * change the run. It exits with 1 when a check fails.
 *
 * @module
 */

import type { Schema } from "@tetsujs/sql";
import { atomic, database, isViolation } from "@tetsujs/sql";
import { SQL } from "bun";
import type { GeneratedAlways, Kysely } from "kysely";
import { sql } from "kysely";

declare module "@tetsujs/sql" {
  interface Constraints {
    handles_pkey: true;
  }
}

const server = Bun.env.DATABASE_URL;

if (server === undefined || server === "") {
  throw new Error(
    "the load probe needs a Postgres server where it may create a database: DATABASE_URL is not set",
  );
}

/** Workers running the mix at once. */
const WORKERS = Number(Bun.env.WORKERS ?? 64);

/** Connections of the pool. */
const POOL = Number(Bun.env.POOL ?? 10);

/** How long the mix runs alone, in seconds. */
const MIX_SECONDS = Number(Bun.env.MIX_SECONDS ?? 60);

/** How long it runs while backends are ended, in seconds. */
const KILL_SECONDS = Number(Bun.env.KILL_SECONDS ?? 30);

/** The name the pool's sessions carry, by which the server finds them. */
const APPLICATION = "tetsu_load";

/** The accounts the transfers move units between, and what each holds. */
const ACCOUNTS = 200;
const BALANCE = 1000;

/** The tables of the probe, on a database of its own. */
const SEED = `
  create table accounts (
    id int8 primary key,
    balance int8 not null check (balance >= 0)
  );
  insert into accounts select g, ${BALANCE} from generate_series(1, ${ACCOUNTS}) g;
  create table counters (id int4 primary key, n int4 not null);
  insert into counters select g, 0 from generate_series(1, ${WORKERS}) g;
  create table marks (
    worker int4 not null,
    seq int4 not null,
    primary key (worker, seq)
  );
  create table handles (handle text primary key);
  insert into handles values ('taken');
  create table numbers (id int8 generated always as identity primary key, i4 int4);
  analyze;
`;

/** The tables, as Kysely types them. */
interface Database {
  accounts: { id: bigint; balance: bigint };
  counters: { id: number; n: number };
  marks: { worker: number; seq: number };
  handles: { handle: string };
  numbers: { id: GeneratedAlways<bigint>; i4: number | null };
}

/** What `database()` reads of a generated file: no migration, and no arrays. */
const schema: Schema<Database> = {
  journal: "migrations",
  migration: null,
  arrays: {},
};

/** An answer that is not the one asked for. */
class Wrong extends Error {
  override readonly name = "Wrong";
}

/**
 * How an operation ended: as asked; with the failure the mix asks for; with
 * a lost connection while backends are ended; with a failure of no kind it
 * asks for; or with a wrong answer.
 */
type Outcome = "ok" | "refused" | "tolerated" | "unexpected" | "wrong";

/** What a worker knows of its own rows. */
interface Worker {
  readonly id: number;

  /** Its counter, as its units of work left it; unknown after a lost one. */
  counter: number | undefined;

  /** The keys of marks it has asked to insert. */
  issued: number;

  /** The marks it knows are inserted. */
  confirmed: number;

  /** The markers it has echoed. */
  echoed: number;
}

/**
 * A run of the mix: how its operations ended, and how long they took, as
 * a sample of at most {@link SAMPLE} of each, so that the probe's own
 * memory stays flat.
 */
interface Phase {
  readonly name: string;
  readonly kills: boolean;
  readonly counts: Map<string, Map<Outcome, number>>;
  readonly times: Map<string, number[]>;
  readonly faults: string[];
}

/** How many durations of each operation a phase keeps. */
const SAMPLE = 20_000;

/** A random integer from `low` to `high`, both included. */
function between(low: number, high: number): number {
  return low + Math.floor(Math.random() * (high - low + 1));
}

/** The URL of database `name` on the server `DATABASE_URL` names. */
function urlOf(name: string): string {
  const url = new URL(server as string);

  url.pathname = `/${name}`;

  return url.href;
}

/** Whether a failure is a connection the server ended, or one closed after it. */
function isLost(error: unknown): boolean {
  const { code, errno, message } = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };

  return (
    errno === "57P01" ||
    (typeof code === "string" && /CONNECTION|SOCKET/.test(code)) ||
    (typeof message === "string" &&
      /connection|terminat|socket|closed/i.test(message))
  );
}

/** The failure a promise rejects with, or nothing when it resolves. */
function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );
}

const name = `tetsu_load_${crypto.randomUUID().replaceAll("-", "")}`;
const owner = new SQL({ url: server, max: 1 });

await owner.unsafe(`create database ${name}`);
await owner.unsafe(`alter database ${name} set synchronous_commit = off`);

const admin = new SQL({ url: urlOf(name), max: 1 });
const db: Kysely<Database> = database(schema, {
  url: urlOf(name),
  max: POOL,
  connection: { application_name: APPLICATION },
});
const workers: Worker[] = Array.from({ length: WORKERS }, (_, id) => ({
  id,
  counter: 0,
  issued: 0,
  confirmed: 0,
  echoed: 0,
}));
const unhandled: unknown[] = [];
const printed: string[] = [];
let abandoned = 0;
let kills = 0;

process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

const consoleError = console.error;

console.error = (...args: unknown[]) => {
  const line = args.map(String).join(" ");

  if (line.includes("failed in the background after abortion")) {
    abandoned += 1;
  } else {
    printed.push(line);
  }
};

/** A worker's counter as the database holds it. */
async function counterOf(worker: Worker): Promise<number> {
  const row = await db
    .selectFrom("counters")
    .select("n")
    .where("id", "=", worker.id + 1)
    .executeTakeFirstOrThrow();

  return row.n;
}

/** Learns a worker's counter again, after a unit of work whose end is unknown. */
async function known(worker: Worker): Promise<number> {
  if (worker.counter === undefined) {
    worker.counter = await counterOf(worker);
  }

  return worker.counter;
}

/** Adds one to a worker's counter, in `trx`. */
async function count(trx: Kysely<Database>, worker: Worker): Promise<void> {
  await trx
    .updateTable("counters")
    .set((eb) => ({ n: eb("n", "+", 1) }))
    .where("id", "=", worker.id + 1)
    .execute();
}

/** One query that echoes a marker of its own. */
async function echo(worker: Worker): Promise<boolean> {
  worker.echoed += 1;

  const marker = `${worker.id}:${worker.echoed}`;
  const number = between(-1_000_000, 1_000_000);
  const { rows } = await sql<{ marker: string; number: number }>`
    select ${marker}::text as marker, ${number}::int4 as number`.execute(db);

  return (
    rows.length === 1 &&
    rows[0]?.marker === marker &&
    rows[0]?.number === number
  );
}

/** The operations of the mix, by name, each with its weight. */
const OPERATIONS: Record<
  string,
  readonly [number, (worker: Worker) => Promise<Outcome>]
> = {
  echo: [25, async (worker) => ((await echo(worker)) ? "ok" : "wrong")],
  burst: [
    3,
    async (worker) => {
      const answers = await Promise.all(
        Array.from({ length: 20 }, () => echo(worker)),
      );

      return answers.every(Boolean) ? "ok" : "wrong";
    },
  ],
  read: [
    12,
    async () => {
      const id = BigInt(between(1, ACCOUNTS));
      const rows = await db
        .selectFrom("accounts")
        .select("id")
        .where("id", "=", id)
        .execute();

      return rows.length === 1 && rows[0]?.id === id ? "ok" : "wrong";
    },
  ],
  insert: [
    10,
    async (worker) => {
      const seq = worker.issued;

      worker.issued += 1;

      const row = await db
        .insertInto("marks")
        .values({ worker: worker.id, seq })
        .returning("seq")
        .executeTakeFirstOrThrow();

      worker.confirmed += 1;

      return row.seq === seq ? "ok" : "wrong";
    },
  ],
  transfer: [
    12,
    async () => {
      const a = between(1, ACCOUNTS);
      const b = ((a - 1 + between(1, ACCOUNTS - 1)) % ACCOUNTS) + 1;
      const [from, to] = Math.random() < 0.5 ? [a, b] : [b, a];

      await db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom("accounts")
          .select(["id", "balance"])
          .where("id", "in", [BigInt(a), BigInt(b)])
          .orderBy("id")
          .forUpdate()
          .execute();
        const source = rows.find((row) => row.id === BigInt(from));

        if (rows.length !== 2 || source === undefined) {
          throw new Wrong(`accounts ${a} and ${b} read as ${rows.length} rows`);
        }

        if (source.balance > 0n) {
          await trx
            .updateTable("accounts")
            .set((eb) => ({ balance: eb("balance", "-", 1n) }))
            .where("id", "=", BigInt(from))
            .execute();
          await trx
            .updateTable("accounts")
            .set((eb) => ({ balance: eb("balance", "+", 1n) }))
            .where("id", "=", BigInt(to))
            .execute();
        }
      });

      return "ok";
    },
  ],
  atomic: [
    8,
    async (worker) => {
      const before = await known(worker);

      worker.counter = undefined;
      await atomic(db, async (trx) => {
        await count(trx, worker);

        const failure = await failureOf(
          atomic(trx, async (inner) => {
            await inner
              .insertInto("handles")
              .values({ handle: "taken" })
              .execute();
          }),
        );

        if (!isViolation(failure, "handles_pkey")) {
          throw failure ?? new Wrong("a taken handle was inserted again");
        }
      });
      worker.counter = before + 1;

      return (await counterOf(worker)) === worker.counter ? "ok" : "wrong";
    },
  ],
  rollback: [
    5,
    async (worker) => {
      const before = await known(worker);

      worker.counter = undefined;

      const failure = await failureOf(
        db.transaction().execute(async (trx) => {
          await count(trx, worker);
          await sql`select 1 / 0`.execute(trx);
        }),
      );

      if ((failure as { errno?: unknown } | undefined)?.errno !== "22012") {
        throw failure ?? new Wrong("a transaction that failed committed");
      }

      worker.counter = before;

      return (await counterOf(worker)) === before ? "refused" : "wrong";
    },
  ],
  caught: [
    3,
    async (worker) => {
      const before = await known(worker);

      worker.counter = undefined;

      const failure = await failureOf(
        db.transaction().execute(async (trx) => {
          await count(trx, worker);
          await failureOf(sql`select 1 / 0`.execute(trx));
        }),
      );

      if (
        (failure as { code?: unknown } | undefined)?.code !==
        "ERR_POSTGRES_COMMIT_ROLLED_BACK"
      ) {
        throw (
          failure ?? new Wrong("a transaction whose query failed committed")
        );
      }

      worker.counter = before;

      return (await counterOf(worker)) === before ? "refused" : "wrong";
    },
  ],
  session: [
    7,
    async (worker) => {
      worker.echoed += 1;

      const marker = `${worker.id}:${worker.echoed}`;
      const read = await db.connection().execute(async (session) => {
        await sql`select set_config('tetsu.mark', ${marker}, false)`.execute(
          session,
        );
        await sql`select 1`.execute(session);

        const { rows } = await sql<{
          mark: string;
        }>`select current_setting('tetsu.mark') as mark`.execute(session);

        return rows[0]?.mark;
      });

      return read === marker ? "ok" : "wrong";
    },
  ],
  cancel: [
    8,
    async () => {
      const signal = AbortSignal.timeout(between(1, 30));
      const failure = await failureOf(
        db
          .selectNoFrom(sql<string>`pg_sleep(0.02)::text`.as("slept"))
          .execute({ signal, inflightQueryAbortStrategy: "cancel query" }),
      );

      if (failure === undefined) {
        return "ok";
      }

      if (failure === signal.reason) {
        return "refused";
      }

      throw failure;
    },
  ],
  violation: [
    4,
    async () => {
      const failure = await failureOf(
        db.insertInto("handles").values({ handle: "taken" }).execute(),
      );

      if (failure === undefined) {
        throw new Wrong("a taken handle was inserted again");
      }

      if (!isViolation(failure, "handles_pkey")) {
        throw failure;
      }

      return "refused";
    },
  ],
  fraction: [
    3,
    async () => {
      const failure = await failureOf(
        db.insertInto("numbers").values({ i4: 2.5 }).execute(),
      );

      if (failure === undefined) {
        throw new Wrong("a fraction was written to an integer column");
      }

      if ((failure as { errno?: unknown }).errno !== "22P02") {
        throw failure;
      }

      return "refused";
    },
  ],
};

const names = Object.keys(OPERATIONS);
const total = names.reduce(
  (sum, operation) => sum + (OPERATIONS[operation]?.[0] ?? 0),
  0,
);

/** An operation of the mix, drawn by its weight. */
function draw(): string {
  let left = Math.random() * total;

  for (const operation of names) {
    left -= OPERATIONS[operation]?.[0] ?? 0;

    if (left < 0) {
      return operation;
    }
  }

  return names[0] ?? "echo";
}

/** Runs the mix as one worker, until `until`, writing how each operation ended. */
async function work(
  worker: Worker,
  phase: Phase,
  until: number,
): Promise<void> {
  while (performance.now() < until) {
    const operation = draw();
    const run = OPERATIONS[operation]?.[1];
    const started = performance.now();
    let outcome: Outcome;

    try {
      outcome = run === undefined ? "unexpected" : await run(worker);
    } catch (error) {
      outcome =
        error instanceof Wrong
          ? "wrong"
          : phase.kills && isLost(error)
            ? "tolerated"
            : "unexpected";

      if (outcome !== "tolerated" && phase.faults.length < 10) {
        phase.faults.push(`${operation}: ${String(error)}`);
      }
    }

    const counts = phase.counts.get(operation) ?? new Map<Outcome, number>();
    const times = phase.times.get(operation) ?? [];
    const seen = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const slot = times.length < SAMPLE ? times.length : between(0, seen);

    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    phase.counts.set(operation, counts);

    if (slot < SAMPLE) {
      times[slot] = performance.now() - started;
    }

    phase.times.set(operation, times);
  }
}

/** Ends a backend of the pool every half second or so, until `until`. */
async function end(until: number): Promise<void> {
  while (performance.now() < until) {
    await Bun.sleep(between(300, 700));

    const [row] = await admin`
      select pg_terminate_backend(pid) as ended from pg_stat_activity
      where application_name = ${APPLICATION} and datname = ${name}
      order by random() limit 1`;

    if (row?.ended === true) {
      kills += 1;
    }
  }
}

/** A value at a fraction of sorted `values`, in milliseconds. */
function percentile(values: readonly number[], at: number): string {
  const sorted = values.toSorted((a, b) => a - b);
  const value =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))];

  return (value ?? 0).toFixed(1);
}

/** The checks after a phase, each with whether it held. */
async function checks(phase: Phase): Promise<[string, boolean][]> {
  await Bun.sleep(500);

  const [balance] =
    await admin`select sum(balance)::int8 as total from accounts`;
  const marks: { worker: number; n: number }[] = await admin`
    select worker, count(*)::int4 as n from marks group by worker`;
  const sessions: { state: string | null; n: number }[] = await admin`
    select state, count(*)::int4 as n from pg_stat_activity
    where application_name = ${APPLICATION} and datname = ${name}
    group by state`;
  const counters: { id: number; n: number }[] =
    await admin`select id, n from counters`;
  const inserted = new Map(marks.map((row) => [row.worker, row.n]));
  const held = new Map(counters.map((row) => [row.id, row.n]));
  const busy = sessions.filter((row) => row.state !== "idle");

  return [
    [
      `the accounts hold ${ACCOUNTS * BALANCE} in all`,
      BigInt(balance?.total ?? 0) === BigInt(ACCOUNTS * BALANCE),
    ],
    [
      "each counter is what its worker's units of work made it",
      workers.every(
        (worker) =>
          worker.counter === undefined ||
          held.get(worker.id + 1) === worker.counter,
      ),
    ],
    [
      "each worker's inserts are there, and none it did not ask for",
      workers.every((worker) => {
        const n = inserted.get(worker.id) ?? 0;

        return phase.kills
          ? n >= worker.confirmed && n <= worker.issued
          : n === worker.confirmed;
      }),
    ],
    [
      `no session of the pool is left in a transaction or running (${sessions.map((row) => `${row.state}: ${row.n}`).join(", ")})`,
      busy.length === 0,
    ],
    [
      "the pool still answers",
      await echo(workers[0] as Worker).catch(() => false),
    ],
  ];
}

/** Runs a phase: the workers for `seconds`, with backends ended or not. */
async function runPhase(
  label: string,
  seconds: number,
  kills: boolean,
): Promise<[Phase, [string, boolean][]]> {
  const phase: Phase = {
    name: label,
    kills,
    counts: new Map(),
    times: new Map(),
    faults: [],
  };
  const until = performance.now() + seconds * 1000;

  await Promise.all([
    ...workers.map((worker) => work(worker, phase, until)),
    ...(kills ? [end(until)] : []),
  ]);

  return [phase, await checks(phase)];
}

const memory: number[] = [];
const sampler = setInterval(() => {
  memory.push(process.memoryUsage().rss);
}, 1000);
const heaps: [string, number][] = [];
let failed = false;

/** The heap once garbage is collected, in megabytes, written down as `label`. */
function weigh(label: string): void {
  Bun.gc(true);
  heaps.push([label, process.memoryUsage().heapUsed / 2 ** 20]);
}

try {
  const [{ version }] =
    await admin`select current_setting('server_version') as version`;

  await admin.unsafe(SEED);
  await echo(workers[0] as Worker);
  weigh("the start");

  const started = process.memoryUsage().rss;

  console.log(
    `bun ${Bun.version}, postgres ${version}: ${WORKERS} workers on a pool of ${POOL}, ${MIX_SECONDS} s of the mix, then ${KILL_SECONDS} s with backends ended`,
  );

  for (const [label, seconds, ending] of [
    ["the mix", MIX_SECONDS, false],
    ["the mix, backends ended", KILL_SECONDS, true],
  ] as const) {
    if (seconds <= 0) {
      continue;
    }

    const [phase, held] = await runPhase(label, seconds, ending);

    console.log(`\n${phase.name}${ending ? `: ${kills} backends ended` : ""}`);
    console.table(
      Object.fromEntries(
        [...phase.counts].map(([operation, counts]) => {
          const times = phase.times.get(operation) ?? [];

          return [
            operation,
            {
              ok: counts.get("ok") ?? 0,
              refused: counts.get("refused") ?? 0,
              tolerated: counts.get("tolerated") ?? 0,
              wrong: counts.get("wrong") ?? 0,
              unexpected: counts.get("unexpected") ?? 0,
              "p50 ms": percentile(times, 0.5),
              "p99 ms": percentile(times, 0.99),
            },
          ];
        }),
      ),
    );

    for (const fault of phase.faults) {
      console.log(`  fault: ${fault}`);
    }

    for (const [check, ok] of held) {
      console.log(`  ${ok ? "ok  " : "FAIL"} ${check}`);
    }

    weigh(`after ${phase.name}`);

    const faulty = [...phase.counts.values()].some(
      (counts) =>
        (counts.get("wrong") ?? 0) + (counts.get("unexpected") ?? 0) > 0,
    );

    failed ||= faulty || held.some(([, ok]) => !ok);
  }

  const closed = await Promise.race([
    db.destroy().then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  const peak = Math.max(started, ...memory);

  console.log(`\n  ${closed ? "ok  " : "FAIL"} db.destroy() resolves`);
  console.log(
    `  ${unhandled.length === 0 ? "ok  " : "FAIL"} no promise rejected unhandled${unhandled.length === 0 ? "" : `: ${unhandled.slice(0, 3).map(String).join("; ")}`}`,
  );
  console.log(
    `  memory: ${(started / 2 ** 20).toFixed(0)} MB at the start, ${(peak / 2 ** 20).toFixed(0)} MB at the peak, ${((memory.at(-1) ?? started) / 2 ** 20).toFixed(0)} MB at the end`,
  );
  console.log(
    `  heap, once collected: ${heaps.map(([label, mb]) => `${mb.toFixed(1)} MB ${label}`).join(", ")}`,
  );
  console.log(
    `  Kysely's background failures after abortion, not printed: ${abandoned}`,
  );

  for (const line of printed.slice(0, 5)) {
    console.log(`  printed: ${line}`);
  }

  failed ||= !closed || unhandled.length > 0;
} finally {
  clearInterval(sampler);
  console.error = consoleError;
  await admin.close();
  await owner.unsafe(`drop database if exists ${name} with (force)`);
  await owner.close();
}

process.exitCode = failed ? 1 : 0;
