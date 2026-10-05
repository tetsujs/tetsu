/**
 * A generator, piped to a response at the rate the client reads it.
 *
 * This is the machinery `sse()` is built on, exported because the wire
 * format is the only part of it that is about server-sent events. A
 * server-to-server feed wants newline-delimited JSON, an export wants CSV,
 * a proxy wants whatever it was handed — and none of them should have to
 * rediscover backpressure, the abort signal, ending the generator on
 * cancellation, or reporting what the stream did.
 *
 * ```ts
 * handler: (ctx) =>
 *   stream(
 *     ctx,
 *     async function* (signal) {
 *       for await (const row of rows.watch({ signal })) {
 *         yield `${JSON.stringify(row)}\n`;
 *       }
 *     },
 *     { contentType: "application/x-ndjson" },
 *   );
 * ```
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { reportFailure } from "@tetsujs/core";

/** How a stream ended. */
export type StreamReason =
  /** The generator ran out on its own. */
  | "ended"
  /**
   * Nobody is reading any more — the client disconnected, or the pipeline
   * discarded the response the stream was the body of — or `until` fired.
   */
  | "cancelled"
  /** The generator threw. What had already gone out stayed valid. */
  | "failed";

/** One finished stream. */
export interface StreamSummary {
  /**
   * Chunks the generator yielded and the stream wrote, not counting
   * keep-alives or the opening of `sse()`. For `sse()` that is one per
   * event.
   */
  readonly chunks: number;

  /**
   * Bytes enqueued, keep-alives and the opening of `sse()` included — what
   * the stream put on the wire rather than what the application meant to
   * say.
   */
  readonly bytes: number;

  /** How long the stream lived, in milliseconds, to the microsecond. */
  readonly durationMs: number;

  readonly reason: StreamReason;
}

/**
 * Something written on a schedule, so an idle connection stays open.
 *
 * The first to close one is Bun: `idleTimeout`, 10 seconds unless the
 * server sets another, ends a connection that has sent nothing for that
 * long — before a beat every 15 seconds ever goes out. So once the stream
 * is read, it sets its own request's timeout to the interval and ten
 * seconds more, with `ctx.server.timeout()`. The connection is let go
 * only when a beat is ten seconds late — the patience Bun gives any
 * connection — and every other request keeps the server's setting.
 *
 * Sets, not raises: Bun does not say what the server's `idleTimeout` is,
 * so a longer one, or `0`, is replaced for these requests too. A client
 * that stops reading is then let go after it, and an interval of more
 * than four minutes is cut at Bun's 255 seconds.
 *
 * Finite on purpose. `0` turns the timeout off, which is what Bun's own
 * guide to event streams does, and keeps a client that stopped reading
 * connected for good; a client that reads slowly is not cut either way,
 * because every chunk the socket sends resets the timer. On HTTP/1.1 the
 * value also stays with the connection after the stream, until its next
 * request — `0` would leave an idle connection open with nothing to close
 * it.
 *
 * It is set as the stream is read, after the handler has returned, so it
 * replaces a timeout the handler set itself. The generator starts after
 * it, and a source that wants another timeout — the server's longer one,
 * or none — sets its own with `ctx.server.timeout()`.
 *
 * Bun ignores a request's own timeout on a unix socket and over HTTP/3,
 * and the server's `idleTimeout` decides there. Over HTTP/3 it has to sit
 * above the interval; on a unix socket, whose options Bun's types give no
 * `idleTimeout`, the interval has to stay under 8 seconds: Bun's clock
 * ticks every 4, so its default of 10 can end an idle connection after 8.
 * Bun waits 255 seconds at most, so an interval of more than four minutes
 * keeps no connection open anywhere.
 */
export interface KeepAlive {
  /**
   * How often, in milliseconds, at most 2³¹ − 1; `0` turns it off. `NaN`,
   * `Infinity`, a negative or anything not a number is refused with a
   * `TypeError` where the stream is made.
   */
  readonly everyMs: number;

  /**
   * What to write. It has to be something the consumer's parser ignores —
   * a comment in a format that has them, a blank line in one that does
   * not, nothing at all in a format where neither is true.
   */
  readonly chunk: string;
}

/** How the stream behaves and what it answers with. */
export interface StreamOptions {
  /** The response's `content-type`. Omitted, none is set. */
  readonly contentType?: string;

  /** Status of the response. `200` by default. */
  readonly status?: number;

  /**
   * Headers to send alongside — `cache-control`, and whatever else.
   *
   * A stream that should arrive as it is written, behind nginx, sends
   * `x-accel-buffering: no`, as `sse()` does on its own: nginx buffers a
   * proxied response by default, and passes nothing on until its buffer
   * fills or the stream ends.
   */
  readonly headers?: Record<string, string>;

  /**
   * A filler written while nothing else is, which also sets the request's
   * idle timeout above its interval — see {@link KeepAlive}.
   * Off by default, and then the server's `idleTimeout` ends a stream that
   * writes nothing for that long.
   */
  readonly keepAlive?: KeepAlive;

  /**
   * Called once when the stream is over, with what it did — for a stream
   * that went out: one made and never sent has nothing to report.
   */
  readonly onEnd?: (summary: StreamSummary) => void;

  /**
   * Ends the stream when it fires, as a client leaving would, with
   * `"cancelled"`.
   *
   * What a server that is stopping closes its streams on — `draining`
   * from `@tetsujs/lifecycle`. `server.stop()` waits for every response in
   * flight, and a stream is one that never finishes on its own: left open,
   * it holds the stop for the whole grace period, and the process exits as
   * a forced stop.
   *
   * The stream closes even when its generator waits on something else;
   * the generator is unwound when it waits on the signal it was handed,
   * which includes this one.
   */
  readonly until?: AbortSignal;
}

/**
 * Builds a streaming response from an async generator.
 *
 * The generator is handed an `AbortSignal` that fires when the stream is
 * over, whichever way it ended — the client disconnected, the consumer
 * cancelled, the generator itself failed. It is not `ctx.req.signal`
 * directly: a source wants to know that this stream is finished, not which
 * of the ways finished it.
 *
 * **Passing it on is what makes cleanup work**, and it is the caller's job
 * rather than this module's. A generator between two `yield`s leaves on
 * its own — the loop sees the abort at the next chunk, and `return()` runs
 * its `finally`. A generator parked inside an `await` is resumed by
 * nothing: `return()` on it is queued behind that `await` and applies only
 * once it settles, so an `await` on a source that has gone quiet never
 * unwinds, and the subscription inside it lives as long as the process.
 * Neither cancelling the stream nor `return()` changes that — both were
 * measured, both fire, neither wakes it — which is why the signal goes to
 * the source instead.
 *
 * So the rule, stated plainly: **a stream ends with the connection if its
 * generator keeps yielding, or if it waits on the signal.** A generator
 * that does neither leaks, and no amount of care out here can collect it.
 *
 * A generator that fails instead of ending is reported — to the
 * application's `reportError`, with `source: "stream"` — and the stream is
 * closed where it stood, so what already went out stays valid and the
 * client sees an ordinary end of stream. Letting the failure escape
 * instead would reach no one the application can hear: the platform prints
 * a raw stack and tears the connection down, and whether the bytes already
 * queued are lost with it depends on whether a macrotask happened to run
 * in between.
 */
export function stream(
  ctx: BaseCtx,
  source: (signal: AbortSignal) => AsyncGenerator<string, void, undefined>,
  options: StreamOptions = {},
): Response {
  return openStream(ctx, source, options);
}

/**
 * {@link stream}, with a first chunk written as soon as the stream starts.
 *
 * Bun sends the status and headers with the first chunk of the body, not
 * before: a feed with nothing to say yet says nothing at all, and its
 * client cannot tell a stream that is open from a server that has not
 * answered. A browser's `EventSource` waits in "connecting", and a client
 * with a timeout on the headers gives up. The opening is what answers: it
 * goes out at once, counted in `bytes` like a keep-alive and not in
 * `chunks`.
 *
 * Internal to the package, for `sse()`, whose format has comments to open
 * with. A format without them has nothing a parser would skip, and
 * `stream()` writes only what its generator yields.
 */
export function openStream(
  ctx: BaseCtx,
  source: (signal: AbortSignal) => AsyncGenerator<string, void, undefined>,
  options: StreamOptions,
  opening?: string,
): Response {
  if (options.keepAlive !== undefined) {
    interval("a keep-alive's everyMs", options.keepAlive.everyMs);
  }

  const encoder = new TextEncoder();
  const ending = new AbortController();
  const signal = AbortSignal.any(
    options.until
      ? [ctx.req.signal, ending.signal, options.until]
      : [ctx.req.signal, ending.signal],
  );

  const chunks = source(signal);

  const startedAt = performance.now();

  let beating: ReturnType<typeof setInterval> | undefined;
  let reading = false;
  let stopFromOutside = (): void => {};
  let written = 0;
  let bytes = 0;
  let over = false;

  /**
   * Ends the stream once, whichever path got here first.
   *
   * Four of them do — the generator running out, the consumer going away,
   * the generator throwing, and a keep-alive finding the controller shut —
   * and the summary must be reported once, not once per path.
   */
  const done = (reason: StreamReason): void => {
    if (beating !== undefined) {
      clearInterval(beating);

      beating = undefined;
    }

    ending.abort();
    options.until?.removeEventListener("abort", stopFromOutside);

    if (over) {
      return;
    }

    over = true;

    try {
      options.onEnd?.({
        chunks: written,
        bytes,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        reason,
      });
    } catch (error) {
      /**
       * The response left long ago, so there is nothing to map this to and
       * nobody to answer — the same reason the generator's own failure is
       * reported rather than raised.
       */
      reportFailure(ctx, "stream", error);
    }
  };

  /** Writes one chunk and counts what it put on the wire. */
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: string,
  ): void => {
    const encoded = encoder.encode(chunk);

    bytes += encoded.byteLength;

    controller.enqueue(encoded);
  };

  /**
   * Starts the keep-alive, which is the only thing that writes on its
   * own schedule rather than on demand — once the stream is being read.
   *
   * It skips a beat while the last one is still queued — the queue holds
   * nothing ahead of a read, so anything in it means the consumer has not
   * taken it yet: a stream with a full queue is backed up, not idle,
   * and the filler exists only to keep an idle connection from being
   * closed by a proxy. Without the check a stalled stream would collect
   * one every interval for as long as it stalls, which is small and
   * unbounded — the shape of the defect this whole pull loop exists to
   * remove, in miniature.
   *
   * No test separates the two: the fillers are a few bytes each and they
   * queue behind the megabyte the transport is already holding, so
   * nothing observable through a socket ever reaches them. The check is
   * kept on the reasoning, not on a measurement, and this is the note
   * saying so.
   *
   * Starting, it sets the request's idle timeout above the interval, so
   * that Bun waits for the beats — see {@link KeepAlive}. A server that
   * cannot take one — a stand-in in a unit test, a context built by hand,
   * `testCtx()` from before 0.6.2 — has no connection to time out, and
   * the stream goes on as it did before there was a timeout to set.
   */
  const keepAlive = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    const alive = options.keepAlive;

    if (!alive || alive.everyMs === 0 || over) {
      return;
    }

    try {
      ctx.server.timeout(ctx.req, idleTimeoutFor(alive.everyMs));
    } catch {
      // A stand-in server, with no connection to time out.
    }

    beating = setInterval(() => {
      if ((controller.desiredSize ?? 0) < 0) {
        return;
      }

      try {
        emit(controller, alive.chunk);
      } catch {
        done("cancelled");
      }
    }, alive.everyMs);
  };

  /** Ends the stream when `until` fires — or at once, if it has. */
  const listen = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    const until = options.until;

    if (!until) {
      return;
    }

    stopFromOutside = () => {
      done("cancelled");
      close(controller);
      chunks.return().catch((error: unknown) => {
        reportFailure(ctx, "stream", error);
      });
    };

    if (until.aborted) {
      stopFromOutside();
    } else {
      until.addEventListener("abort", stopFromOutside, { once: true });
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      /**
       * Writes the opening, and nothing else.
       *
       * Everything that lives with the stream — the generator, the
       * keep-alive, the listener on `until` — waits for the first read,
       * because a stream can be made and never sent: a handler that built
       * one and then threw leaves it to nobody, and a timer or a listener on
       * a long-lived signal started here held it for as long as the process
       * lived. The queue's high-water mark is `0` for the same reason, so no
       * read is asked for before a consumer asks.
       */
      start(controller) {
        if (opening !== undefined) {
          emit(controller, opening);
        }
      },

      /**
       * Produces one chunk, and only when the consumer has room for it.
       *
       * This is the whole of the backpressure: the platform calls `pull`
       * while the queue wants more and stops calling it when it does not, so
       * exactly one `next()` is ever in flight and the generator advances at
       * the rate the client reads. Driving the generator from a loop instead
       * asks it for everything at once, because `enqueue` never blocks and
       * never refuses: a client that stopped reading had a million chunks
       * built for it and held in memory.
       *
       * The cost of the shape is that leaving a loop no longer ends the
       * generator, because there is no loop; `cancel` calls `return()` in
       * its place.
       */
      async pull(controller) {
        if (!reading) {
          reading = true;
          listen(controller);
          keepAlive(controller);
        }

        if (over) {
          return;
        }

        try {
          const next = await chunks.next();

          if (next.done || signal.aborted) {
            /**
             * The signal is checked first on purpose: a generator that takes
             * it does the polite thing and returns, so `done` would be true
             * on a stream the client walked away from. What ended it is the
             * departure, and that is what the summary should say.
             *
             * No test separates this from always reporting `ended`, and that
             * is not a gap in the tests. Every way the signal becomes true
             * here runs through a `done` call that has already fixed the
             * reason — `cancel` on the consumer's side, the keep-alive
             * finding a shut controller — and all of them say `cancelled`
             * too. The branch decides a race whose other outcome agrees with
             * it, which is why it is kept and why nothing can observe it.
             */
            done(signal.aborted ? "cancelled" : "ended");
            close(controller);

            return;
          }

          written += 1;

          emit(controller, next.value);
        } catch (error) {
          /**
           * A source that takes the signal, as it is asked to, rejects when
           * the client leaves: `fetch`, `events.on` and a timer from
           * `node:timers/promises` all throw the signal's `AbortError`. That
           * is the departure arriving, not the source failing, and reporting
           * it made every ordinary disconnect an error in the logs.
           */
          if (signal.aborted && isDeparture(error, signal)) {
            done("cancelled");
            close(controller);

            return;
          }

          reportFailure(ctx, "stream", error);

          // A source parked on the signal runs its `finally` here, inside the
          // pending `next()`: a cleanup that throws after the client left is
          // a failure worth reporting, on a stream the client ended.
          done(signal.aborted ? "cancelled" : "failed");
          close(controller);
        }
      },

      /**
       * The stream's own end of life, told by whoever consumed it.
       *
       * Not a backstop: this is the only thing that ends a stream whose
       * response never reached the client. The pipeline releases a response
       * it discards — one a `beforeResponse` hook replaced, one an error
       * displaced, one a `HEAD` request answered without — by cancelling its
       * body, and the request's own signal says nothing in those cases,
       * because the request itself ended normally.
       *
       * A client that leaves aborts `ctx.req.signal` first, so that path
       * does not depend on this line; the request whose response was thrown
       * away depends on nothing else.
       */
      cancel() {
        done("cancelled");

        /**
         * `return()` runs the generator's `finally` — the cleanup a source
         * is asked to write — and a cleanup can fail: a broker that is gone
         * refuses to close a subscription. Nobody awaits this promise, and a
         * rejection nobody handles ends the process, every other connection
         * with it. It is reported instead, as the stream's own failure.
         */
        chunks.return().catch((error: unknown) => {
          reportFailure(ctx, "stream", error);
        });
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      ...(options.contentType
        ? { "content-type": options.contentType }
        : undefined),
      ...options.headers,
    },
  });
}

/**
 * Checks a keep-alive interval: `0`, which turns it off, or a number of
 * milliseconds a timer holds, at most 2³¹ − 1.
 *
 * Refused rather than read as off, as `rateLimit()` refuses a window of
 * `NaN`: `Number()` of a variable that is not set is `NaN`, and a
 * heartbeat that went missing without a word lets Bun close every feed
 * that goes quiet — the failure it is there to prevent, with nothing in
 * the logs. Nor run as given: a timer makes an interval it cannot hold a
 * beat every millisecond.
 *
 * Internal to the package: `sse()` checks its heartbeat with it, under the
 * name its caller wrote.
 */
export function interval(what: string, everyMs: number): number {
  if (typeof everyMs === "number" && everyMs >= 0 && everyMs <= 2_147_483_647) {
    return everyMs;
  }

  const why = Number.isNaN(everyMs)
    ? " — Number() of a variable that is not set is NaN"
    : "";

  throw new TypeError(
    `${what} must be 0, which turns it off, or a number of milliseconds up to 2147483647, not ${named(everyMs)}${why}`,
  );
}

/**
 * A value as a message names it: a number as itself, and anything else
 * with its type — a string from a JSON file prints as a number would, and
 * the reader would be left wondering what was wrong with `50`.
 */
function named(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    return `the string ${JSON.stringify(value)}`;
  }

  return `a value of type ${typeof value}`;
}

/**
 * The idle timeout of a request whose stream beats every `everyMs`, in the
 * whole seconds Bun takes: the interval rounded up and ten seconds more,
 * at most 255.
 *
 * The ten seconds also absorb Bun's clock, which checks idleness every
 * four seconds: a timeout of N seconds can fire up to four of them early.
 */
function idleTimeoutFor(everyMs: number): number {
  return Math.min(Math.ceil(everyMs / 1_000) + 10, 255);
}

/**
 * Whether a source's rejection is the departure itself — the signal's
 * reason, or an `AbortError` an API made of it — rather than something the
 * source did on its way out.
 */
function isDeparture(error: unknown, signal: AbortSignal): boolean {
  return (
    error === signal.reason ||
    (error as { name?: unknown } | null)?.name === "AbortError"
  );
}

/**
 * Ends the stream, tolerating a client that already left.
 *
 * `close()` throws on a controller the platform closed when the connection
 * went away, and that is not a failure worth reporting: the stream ended
 * exactly as it was going to.
 */
function close(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    // The stream is already closed because the client left.
  }
}
