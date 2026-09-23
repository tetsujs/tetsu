/**
 * The server side of the load benchmark's protocol, shared by every target.
 *
 * A target is a process of its own, so what it costs — memory, processor
 * time, startup — is its alone: in one process the frameworks would share
 * a heap, and the load generator would share the thread it is measuring.
 * The parent spawns a target with an IPC channel; the target announces
 * itself once listening, then answers `stats` requests with its own
 * readings.
 *
 * @module
 */

/** What a target reports when asked, read inside its own process. */
export interface TargetStats {
  readonly type: "stats";
  readonly rss: number;
  readonly heapUsed: number;
  /** Processor time the process has used so far, user plus system, in µs. */
  readonly cpuMicros: number;
}

/** The first message a target sends: it listens, and how long that took. */
export interface TargetReady {
  readonly type: "ready";
  readonly port: number;
  /** Milliseconds from process start to listening, module loading included. */
  readonly startupMs: number;
}

function stats(): TargetStats {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();

  return {
    type: "stats",
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    cpuMicros: cpu.user + cpu.system,
  };
}

/**
 * Announces a listening server to the parent and answers its requests.
 *
 * `{ type: "stats", gc: true }` collects garbage first, for readings that
 * should not count what is merely waiting to be freed. `{ type: "exit" }`
 * ends the process normally, which is what lets `bun --cpu-prof` write
 * its profile — a killed process writes none.
 */
export function host(port: number): void {
  const ready: TargetReady = {
    type: "ready",
    port,
    startupMs: performance.now(),
  };

  process.send?.(ready);

  process.on("message", (message: { type?: string; gc?: boolean }) => {
    if (message.type === "exit") {
      process.exit(0);
    }

    if (message.type !== "stats") {
      return;
    }

    if (message.gc) {
      Bun.gc(true);
    }

    process.send?.(stats());
  });
}
