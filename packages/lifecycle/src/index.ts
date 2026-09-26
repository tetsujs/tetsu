/**
 * Stopping a server without cutting the requests it is still serving.
 *
 * ```ts
 * const server = Bun.serve({ ...app });
 *
 * onShutdownSignals(server, { close: [() => pool.end()] });
 * ```
 *
 * A process with several servers — a public API and an admin surface, each
 * on its own port — passes them all: `onShutdownSignals([api, admin], …)`.
 * They drain together, within one grace period, and what they share is
 * closed once, after the last of them.
 *
 * Starting needs nothing from this package: opening a pool and warming a
 * cache is an `await` before `Bun.serve`, and an `onStart` would only hide
 * where the process actually begins.
 *
 * Stopping does need something, because `Bun.Server.stop()` has three
 * behaviours a caller has to know about — all three measured, not assumed:
 *
 * | | |
 * | --- | --- |
 * | an in-flight request | `stop()` waits for it and it completes normally |
 * | an open WebSocket | `stop()` never resolves; `stop(true)` closes it at once |
 * | a socket the server itself closed | **neither form resolves** |
 *
 * The third is the trap: an application that closes a socket on its own —
 * a protocol violation, an idle timeout — can never `await` its own stop.
 * Everything here therefore races the platform against a deadline instead
 * of trusting it to return.
 *
 * @module
 */

import type { Server } from "bun";

/** A resource to release once the server is done with it. */
export type Closer = () => unknown | Promise<unknown>;

/**
 * What can be stopped: a `Bun.serve` server, or anything with its `stop`.
 * The package asks for nothing else, so it stops any server, not only a
 * Tetsu application's.
 */
export type Stoppable = Pick<Server<unknown>, "stop">;

/** One server, or all the servers of a process. */
export type Servers = Stoppable | readonly Stoppable[];

/** How the shutdown is paced. */
export interface ShutdownOptions {
  /**
   * Resources to release, in order, after the server has stopped.
   *
   * After, never before: a request still in flight may reach for the pool
   * that closing it early would have taken away.
   */
  readonly close?: readonly Closer[];

  /**
   * How long to keep serving after the stop was asked for, before the
   * server is told to stop at all. Zero by default.
   *
   * This is the half of a graceful shutdown that stopping gracefully does
   * not cover. In Kubernetes the `SIGTERM` and the pod's removal from the
   * Service travel **in parallel**: the signal arrives at once, while the
   * endpoint change has to reach kube-proxy, the ingress and whatever
   * balancer sits in front, which takes hundreds of milliseconds and
   * sometimes seconds. Stopping the moment the signal lands therefore cuts
   * exactly the requests that are still being routed here — the ones this
   * package exists to protect.
   *
   * So the sequence is: say we are not ready, keep serving for this long
   * while the news travels, and only then drain. A second signal cuts the
   * wait short, the same way it cuts the grace period short.
   *
   * Zero by default because the delay is pure cost anywhere the caller is
   * not behind a balancer that has to be told — a test, a CLI, a process
   * nobody is routing to. Set it where something has to hear.
   *
   * **A delay on its own changes nothing.** Something has to start
   * answering readiness with a failure while it runs, or the balancer goes
   * on sending traffic and the wait only postpones the same cut. See
   * `stopping` on the return of {@link onShutdownSignals}.
   */
  readonly preStopDelayMs?: number;

  /**
   * How long in-flight requests may take, in milliseconds. Ten seconds by
   * default; past it the remaining connections are closed.
   */
  readonly graceMs?: number;

  /**
   * How long the forced close may take before it too is abandoned, in
   * milliseconds. One second by default.
   *
   * It has a deadline of its own because `stop(true)` can hang as well —
   * see the table above.
   */
  readonly forceMs?: number;
}

/** What {@link onShutdownSignals} hands back. */
export interface ShutdownHandle {
  /**
   * Aborts the moment a stop is asked for, before anything else happens.
   *
   * This is what makes `preStopDelayMs` worth having: a readiness endpoint
   * that reads it starts failing while the delay runs, the balancer stops
   * routing here, and only then does the server stop. Without it the delay
   * postpones the same cut instead of avoiding it.
   *
   * A standard `AbortSignal`, so it composes with everything that already
   * takes one — a poll loop, a queue consumer, a `fetch` to an upstream
   * that is no longer worth waiting for.
   *
   * @example
   * ```ts
   * const { stopping } = onShutdownSignals(server, { preStopDelayMs: 5_000 });
   *
   * ready = route({
   *   method: "GET",
   *   path: "/readyz",
   *   handler: () => {
   *     if (stopping.aborted) throw new HttpError(503);
   *
   *     return { ok: true };
   *   },
   * });
   * ```
   */
  readonly stopping: AbortSignal;

  /**
   * Removes the signal handlers again, for a process that outlives the
   * server — a test suite, mostly.
   */
  readonly detach: () => void;
}

/** What the shutdown ended up doing. */
export interface ShutdownResult {
  /**
   * Whether the grace period ran out and connections had to be cut — on
   * any of the servers, when there are several.
   */
  readonly forced: boolean;

  /** Whatever the closers threw, in the order they threw it. */
  readonly failures: readonly unknown[];
}

/**
 * Stops a server, or several, and releases what they were using.
 *
 * Never rejects: a closer that throws is collected into the result rather
 * than aborting the rest, because the point of the sequence is that every
 * step runs.
 *
 * @example
 * ```ts
 * const { forced, failures } = await shutdown(server, {
 *   close: [() => pool.end()],
 *   graceMs: 5_000,
 * });
 * ```
 */
export async function shutdown(
  servers: Servers,
  options: ShutdownOptions = {},
): Promise<ShutdownResult> {
  return drain(servers, options);
}

/**
 * The shutdown sequence, with a way to end the grace period early.
 *
 * `stopWaiting` is how a second signal reaches a shutdown already under
 * way: the grace period gives up at once and the rest of the sequence —
 * the forced close, then the closers — runs as it always does. Having one
 * sequence rather than two is the point: an operator in a hurry should get
 * the same release of resources, sooner, not a different and shorter path
 * through the code.
 *
 * Several servers drain side by side, within the one grace period, and
 * only those still draining when it ends are forced: a server that
 * stopped cleanly has nothing left to cut.
 */
async function drain(
  servers: Servers,
  options: ShutdownOptions,
  stopWaiting?: Promise<void>,
): Promise<ShutdownResult> {
  const all: readonly Stoppable[] = Array.isArray(servers)
    ? servers
    : [servers as Stoppable];

  const graceMs = options.graceMs ?? 10_000;
  const forceMs = options.forceMs ?? 1_000;
  const preStopDelayMs = options.preStopDelayMs ?? 0;

  if (preStopDelayMs > 0) {
    await within(Bun.sleep(preStopDelayMs), preStopDelayMs, stopWaiting);
  }

  const stopped = new Set<Stoppable>();

  const drained = await within(
    Promise.all(
      all.map(async (server) => {
        await server.stop();

        stopped.add(server);
      }),
    ),
    graceMs,
    stopWaiting,
  );

  if (!drained) {
    await within(
      Promise.all(
        all
          .filter((server) => !stopped.has(server))
          .map((server) => server.stop(true)),
      ),
      forceMs,
    );
  }

  const failures: unknown[] = [];

  for (const close of options.close ?? []) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }

  return { forced: !drained, failures };
}

/** How the signal handlers behave. */
export interface SignalOptions extends ShutdownOptions {
  /** Which signals end the process. `SIGTERM` and `SIGINT` by default. */
  readonly signals?: readonly NodeJS.Signals[];

  /**
   * Whether the process exits when the shutdown is done. On by default —
   * an installed signal handler that does not end the process leaves it
   * running with nothing serving.
   *
   * The code is `0` when everything drained and closed cleanly, and `1`
   * when connections had to be cut or a closer threw: an orchestrator that
   * reads it learns whether the stop was clean.
   */
  readonly exit?: boolean;

  /**
   * Receives each closer that threw, in place of `console.error`.
   *
   * The same shape `createApp({ reportError })` takes, so one receiver
   * serves both: a report here is `source: "shutdown"`, with no `ctx`.
   * {@link shutdown} itself reports nothing — it returns its failures to
   * the caller; only these handlers, which have no caller to return to,
   * need somewhere to put them.
   */
  readonly reportError?: (report: ShutdownFailure) => unknown;
}

/**
 * A closer that threw while the process was stopping.
 *
 * Shaped like the core's `FailureReport`, without depending on it: this
 * package stops any `Bun.serve` server, not only a Tetsu application.
 */
export interface ShutdownFailure {
  readonly source: "shutdown";
  readonly error: unknown;
}

/**
 * Runs {@link shutdown} when the process is asked to stop.
 *
 * Each further signal asks for less patience, never for less release:
 *
 * | | |
 * | --- | --- |
 * | first | the ordinary sequence: drain within `graceMs`, then close |
 * | second | the grace period gives up now; the forced close and the closers still run |
 * | third | the process ends where it stands |
 *
 * The second is what an operator pressing Ctrl-C twice is asking for —
 * stop waiting, not skip the pool and the flushed logs, which is the whole
 * reason this package exists. The third exists because after the second
 * there is still something unbounded left to wait on: a closer has no
 * deadline, so an operator who has changed their mind needs a way out that
 * does not depend on one returning.
 *
 * @example
 * ```ts
 * const { stopping, detach } = onShutdownSignals(server, {
 *   preStopDelayMs: 5_000,
 *   close: [() => pool.end()],
 * });
 * ```
 *
 * @returns The `stopping` signal and a `detach` that removes the handlers
 * again, for a process that outlives the server — a test suite, mostly.
 */
export function onShutdownSignals(
  servers: Servers,
  options: SignalOptions = {},
): ShutdownHandle {
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];

  const stopping = new AbortController();

  let signalled = 0;
  let cutShort = (): void => {};

  const stopWaiting = new Promise<void>((resolve) => {
    cutShort = resolve;
  });

  const handle = async (): Promise<void> => {
    signalled += 1;

    if (signalled === 2) {
      cutShort();

      return;
    }

    if (signalled > 2) {
      process.exit(1);
    }

    /**
     * Before anything else, including the pre-stop delay: the delay exists
     * so that readiness can start failing while it runs, which it can only
     * do if it has already been told.
     */
    stopping.abort();

    const result = await drain(servers, options, stopWaiting);
    const clean = !result.forced && result.failures.length === 0;

    for (const failure of result.failures) {
      report(options.reportError, failure);
    }

    if (options.exit ?? true) {
      process.exit(clean ? 0 : 1);
    }
  };

  for (const signal of signals) {
    process.on(signal, handle);
  }

  return {
    stopping: stopping.signal,

    detach: () => {
      for (const signal of signals) {
        process.off(signal, handle);
      }
    },
  };
}

/**
 * Waits for a promise, but not forever.
 *
 * Reports whether it settled in time; the promise itself is abandoned
 * rather than cancelled, because a platform call that never resolves
 * cannot be cancelled either.
 */
async function within(
  promise: Promise<unknown>,
  ms: number,
  stopWaiting?: Promise<void>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  const racers = [promise.then(() => true), expired];

  if (stopWaiting) {
    racers.push(stopWaiting.then(() => false));
  }

  try {
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hands one failure to the receiver, or prints it without one.
 *
 * A receiver that throws is printed together with what it was handed: the
 * process is on its way out, and a failure lost here is lost for good.
 */
function report(receive: SignalOptions["reportError"], error: unknown): void {
  if (receive === undefined) {
    console.error("[tetsu] shutdown step failed:", error);

    return;
  }

  try {
    receive({ source: "shutdown", error });
  } catch (failure) {
    console.error("[tetsu] reportError failed:", failure);
    console.error("[tetsu] shutdown step failed:", error);
  }
}
