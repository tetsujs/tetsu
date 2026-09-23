/**
 * One load-generating process of the load benchmark.
 *
 * Runs `concurrency` keep-alive request loops against one URL for a fixed
 * time and prints what happened as one JSON line: the count, the failures,
 * and a histogram of latencies. The parent runs several of these at once
 * and adds their histograms up, so percentiles are over every request, not
 * averages of per-process percentiles.
 *
 * Configured through `LOADER` — a JSON {@link LoaderJob} — because it is
 * spawned, not imported.
 *
 * @module
 */

/** What one loader process is asked to do. */
export interface LoaderJob {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
  readonly concurrency: number;
  readonly durationMs: number;
}

/** What one loader process reports. */
export interface LoaderResult {
  readonly count: number;
  readonly failures: number;
  /** Requests per bucket of {@link bucketMicros}; the last one is overflow. */
  readonly histogram: number[];
}

/** Width of a latency bucket. */
export const bucketMicros = 10;

/** Buckets up to 250 ms; anything slower lands in the last one. */
export const bucketCount = 25_000;

async function run(job: LoaderJob): Promise<LoaderResult> {
  const histogram = new Uint32Array(bucketCount);
  const init: RequestInit = {
    method: job.method,
    ...(job.body === undefined
      ? {}
      : {
          body: job.body,
          headers: { "content-type": "application/json" },
        }),
  };

  let count = 0;
  let failures = 0;
  let running = true;

  const timer = setTimeout(() => {
    running = false;
  }, job.durationMs);

  const loop = async (): Promise<void> => {
    while (running) {
      const started = performance.now();

      try {
        const res = await fetch(job.url, init);

        await res.arrayBuffer();
      } catch {
        failures += 1;

        continue;
      }

      const micros = (performance.now() - started) * 1000;
      const bucket = Math.min(
        Math.floor(micros / bucketMicros),
        bucketCount - 1,
      );

      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
      count += 1;
    }
  };

  await Promise.all(Array.from({ length: job.concurrency }, loop));
  clearTimeout(timer);

  return { count, failures, histogram: Array.from(histogram) };
}

if (import.meta.main) {
  const job = JSON.parse(Bun.env.LOADER ?? "") as LoaderJob;

  console.log(JSON.stringify(await run(job)));
}
