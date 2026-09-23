/**
 * HTTP load: throughput, latency, processor time and memory, per target.
 *
 * Every target is a process of its own (`targets/`), and so is every load
 * generator (`loader.ts`). An earlier version ran the servers and the
 * load inside one process: the generator shared the thread it measured,
 * which capped raw Bun at about 135 000 requests a second where it
 * actually serves about 220 000, and no target's memory could be told
 * from another's.
 *
 * What is read, and why each:
 *
 * - **req/s and latency** (p50, p99) over the measured window — the
 *   headline, and the one that depends on the machine.
 * - **processor time per request**, read by the server from its own
 *   `process.cpuUsage()` — what a request costs, independent of whether
 *   the load generators could keep up.
 * - **memory**: resident set at rest after a collection, its peak under
 *   load, and the heap after the load and a collection, which is what a
 *   leak would grow.
 * - **startup** to listening, module loading included, and the **first
 *   request** to each route — where lazy compilation shows.
 *
 * Elysia is run in the configurations it offers for speed. Elysia 2's
 * ahead-of-time compilation is a build step, so its `aot` target is a
 * bundle this script builds first, next to a plain bundle of the same
 * file that separates what AOT does from what bundling does.
 *
 * Run: `bun run --cwd bench http`. `ROUNDS=3` repeats the whole matrix,
 * interleaved, and reports the median of each reading; `ONLY=tetsu,raw`
 * restricts it to some targets.
 *
 * @module
 */

import { join } from "node:path";
import { aot } from "elysia/plugin/aot/bun";
import type { LoaderJob, LoaderResult } from "./loader.ts";
import { bucketCount, bucketMicros } from "./loader.ts";
import type { TargetReady, TargetStats } from "./targets/host.ts";

const here = import.meta.dir;
const out = join(here, "..", "out");

/** Load generators run at once; three saturate raw Bun on this machine. */
const loaders = 3;

/** Keep-alive connections per load generator. */
const concurrency = 32;

const warmupMs = 1_000;

const durationMs = 5_000;

/** Interval between memory readings while a profile is under load. */
const sampleMs = 250;

const rounds = Number(Bun.env.ROUNDS ?? 1);

const only = Bun.env.ONLY?.split(",");

interface Target {
  readonly name: string;
  readonly command: readonly string[];
  readonly variant?: string;
}

interface Profile {
  readonly name: string;
  readonly path: string;
  readonly method: string;
  readonly body?: string;
}

const profiles: readonly Profile[] = [
  { name: "GET /ping", path: "/ping", method: "GET" },
  { name: "GET /users/:id + 2 hooks", path: "/users/42", method: "GET" },
  {
    name: "POST /items, validated",
    path: "/items",
    method: "POST",
    body: JSON.stringify({ name: "pen", qty: 3 }),
  },
  { name: "GET 404", path: "/missing", method: "GET" },
];

function script(file: string): readonly string[] {
  return ["bun", join(here, "targets", file)];
}

const targets: readonly Target[] = [
  { name: "raw Bun", command: script("raw.ts") },
  { name: "tetsu", command: script("tetsu.ts") },
  {
    name: "tetsu + typebox",
    command: script("tetsu.ts"),
    variant: "typebox",
  },
  { name: "hono", command: script("hono.ts"), variant: "default" },
  { name: "hono/quick", command: script("hono.ts"), variant: "quick" },
  { name: "elysia 1", command: script("elysia1.ts"), variant: "default" },
  {
    name: "elysia 1 aot:false",
    command: script("elysia1.ts"),
    variant: "no-aot",
  },
  {
    name: "elysia 1 precompile",
    command: script("elysia1.ts"),
    variant: "precompile",
  },
  { name: "elysia 2", command: script("elysia2.ts"), variant: "default" },
  {
    name: "elysia 2 bundle",
    command: ["bun", join(out, "elysia2-bundle", "elysia2.js")],
  },
  {
    name: "elysia 2 AOT",
    command: ["bun", join(out, "elysia2-aot", "elysia2.js")],
  },
];

interface ProfileReading {
  readonly rps: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly cpuMicros: number;
  readonly peakRssMb: number;
  readonly failures: number;
}

interface TargetReading {
  readonly startupMs: number;
  readonly firstRequestMs: number;
  readonly idleRssMb: number;
  readonly retainedHeapMb: number;
  readonly profiles: Record<string, ProfileReading>;
}

async function buildElysiaBundles(): Promise<void> {
  const entry = join(here, "targets", "elysia2.ts");

  const plain = await Bun.build({
    entrypoints: [entry],
    outdir: join(out, "elysia2-bundle"),
    target: "bun",
  });

  const compiled = await Bun.build({
    entrypoints: [entry],
    outdir: join(out, "elysia2-aot"),
    target: "bun",
    plugins: [aot(entry)],
  });

  if (!plain.success || !compiled.success) {
    throw new Error(
      `building the Elysia 2 bundles failed:\n${[...plain.logs, ...compiled.logs].join("\n")}`,
    );
  }
}

/** A spawned target and a way to ask it for its readings. */
interface Running {
  readonly ready: TargetReady;
  readonly ask: (gc: boolean) => Promise<TargetStats>;
  readonly stop: () => void;
}

async function start(target: Target): Promise<Running> {
  const waiting: ((stats: TargetStats) => void)[] = [];

  let announce!: (ready: TargetReady) => void;

  const announced = new Promise<TargetReady>((resolve) => {
    announce = resolve;
  });

  const child = Bun.spawn([...target.command], {
    env: { ...process.env, BENCH_VARIANT: target.variant ?? "" },
    stdout: "ignore",
    stderr: "inherit",
    ipc(message: TargetReady | TargetStats) {
      if (message.type === "ready") {
        announce(message);

        return;
      }

      waiting.shift()?.(message);
    },
  });

  const ready = await Promise.race([
    announced,
    Bun.sleep(15_000).then(() => {
      throw new Error(`${target.name} did not start`);
    }),
  ]);

  return {
    ready,
    ask: (gc) =>
      new Promise<TargetStats>((resolve) => {
        waiting.push(resolve);
        child.send({ type: "stats", gc });
      }),
    stop: () => child.kill(),
  };
}

async function load(job: LoaderJob): Promise<LoaderResult[]> {
  return Promise.all(
    Array.from({ length: loaders }, async () => {
      const child = Bun.spawn(["bun", join(here, "loader.ts")], {
        env: { ...process.env, LOADER: JSON.stringify(job) },
        stdout: "pipe",
        stderr: "inherit",
      });

      return JSON.parse(
        await new Response(child.stdout).text(),
      ) as LoaderResult;
    }),
  );
}

function percentile(histogram: readonly number[], fraction: number): number {
  const total = histogram.reduce((sum, n) => sum + n, 0);
  const wanted = total * fraction;

  let seen = 0;

  for (let bucket = 0; bucket < histogram.length; bucket += 1) {
    seen += histogram[bucket] ?? 0;

    if (seen >= wanted) {
      return ((bucket + 1) * bucketMicros) / 1000;
    }
  }

  return (bucketCount * bucketMicros) / 1000;
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

async function firstRequests(base: string): Promise<number> {
  let slowest = 0;

  for (const profile of profiles) {
    const started = performance.now();
    const res = await fetch(base + profile.path, requestInit(profile));

    await res.arrayBuffer();
    slowest = Math.max(slowest, performance.now() - started);
  }

  return Math.round(slowest * 100) / 100;
}

function requestInit(profile: Profile): RequestInit {
  return profile.body === undefined
    ? { method: profile.method }
    : {
        method: profile.method,
        body: profile.body,
        headers: { "content-type": "application/json" },
      };
}

async function measureProfile(
  running: Running,
  base: string,
  profile: Profile,
): Promise<ProfileReading> {
  const job: LoaderJob = {
    url: base + profile.path,
    method: profile.method,
    concurrency,
    durationMs,
    ...(profile.body === undefined ? {} : { body: profile.body }),
  };

  await load({ ...job, durationMs: warmupMs });

  const before = await running.ask(false);

  let peakRss = before.rss;
  let sampling = true;

  const sampler = (async () => {
    while (sampling) {
      await Bun.sleep(sampleMs);
      peakRss = Math.max(peakRss, (await running.ask(false)).rss);
    }
  })();

  const results = await load(job);

  sampling = false;
  await sampler;

  const after = await running.ask(false);
  const count = results.reduce((sum, r) => sum + r.count, 0);
  const histogram = Array.from({ length: bucketCount }, (_, bucket) =>
    results.reduce((sum, r) => sum + (r.histogram[bucket] ?? 0), 0),
  );

  return {
    rps: Math.round(count / (durationMs / 1000)),
    p50Ms: percentile(histogram, 0.5),
    p99Ms: percentile(histogram, 0.99),
    cpuMicros:
      Math.round(((after.cpuMicros - before.cpuMicros) / count) * 100) / 100,
    peakRssMb: megabytes(Math.max(peakRss, after.rss)),
    failures: results.reduce((sum, r) => sum + r.failures, 0),
  };
}

async function measureTarget(target: Target): Promise<TargetReading> {
  const running = await start(target);
  const base = `http://127.0.0.1:${running.ready.port}`;

  try {
    const idle = await running.ask(true);
    const firstRequestMs = await firstRequests(base);
    const readings: Record<string, ProfileReading> = {};

    for (const profile of profiles) {
      readings[profile.name] = await measureProfile(running, base, profile);
    }

    const settled = await running.ask(true);

    return {
      startupMs: Math.round(running.ready.startupMs),
      firstRequestMs,
      idleRssMb: megabytes(idle.rss),
      retainedHeapMb: megabytes(settled.heapUsed),
      profiles: readings,
    };
  } finally {
    running.stop();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function summarize(readings: readonly TargetReading[]): TargetReading {
  const pick = (read: (reading: TargetReading) => number) =>
    median(readings.map(read));

  const profileNames = Object.keys(readings[0]?.profiles ?? {});

  return {
    startupMs: pick((r) => r.startupMs),
    firstRequestMs: pick((r) => r.firstRequestMs),
    idleRssMb: pick((r) => r.idleRssMb),
    retainedHeapMb: pick((r) => r.retainedHeapMb),
    profiles: Object.fromEntries(
      profileNames.map((name) => {
        const of = (read: (p: ProfileReading) => number) =>
          median(readings.map((r) => read(r.profiles[name] as ProfileReading)));

        return [
          name,
          {
            rps: of((p) => p.rps),
            p50Ms: of((p) => p.p50Ms),
            p99Ms: of((p) => p.p99Ms),
            cpuMicros: of((p) => p.cpuMicros),
            peakRssMb: of((p) => p.peakRssMb),
            failures: of((p) => p.failures),
          },
        ];
      }),
    ),
  };
}

await buildElysiaBundles();

const chosen = targets.filter(
  (target) => only === undefined || only.includes(target.name),
);
const collected = new Map<string, TargetReading[]>();

console.log(
  `bun ${Bun.version}, ${loaders} load processes × ${concurrency} connections, ${warmupMs} ms warmup + ${durationMs} ms per profile, ${rounds} round(s)\n`,
);

for (let round = 0; round < rounds; round += 1) {
  for (const target of chosen) {
    const reading = await measureTarget(target);

    collected.set(target.name, [
      ...(collected.get(target.name) ?? []),
      reading,
    ]);
    console.log(`round ${round + 1}: ${target.name} done`);
  }
}

const summary = Object.fromEntries(
  [...collected].map(([name, readings]) => [name, summarize(readings)]),
);

for (const profile of profiles) {
  console.log(`\n${profile.name}`);
  console.table(
    Object.fromEntries(
      Object.entries(summary).map(([name, reading]) => {
        const p = reading.profiles[profile.name] as ProfileReading;

        return [
          name,
          {
            "req/s": p.rps,
            "p50 ms": p.p50Ms,
            "p99 ms": p.p99Ms,
            "cpu µs/req": p.cpuMicros,
            "peak RSS MB": p.peakRssMb,
            failures: p.failures,
          },
        ];
      }),
    ),
  );
}

console.log("\nstartup and memory");
console.table(
  Object.fromEntries(
    Object.entries(summary).map(([name, reading]) => [
      name,
      {
        "startup ms": reading.startupMs,
        "slowest first request ms": reading.firstRequestMs,
        "idle RSS MB": reading.idleRssMb,
        "heap after load MB": reading.retainedHeapMb,
      },
    ]),
  ),
);

await Bun.write(
  join(out, "http.json"),
  JSON.stringify(
    {
      bun: Bun.version,
      rounds,
      summary,
      collected: Object.fromEntries(collected),
    },
    null,
    2,
  ),
);
