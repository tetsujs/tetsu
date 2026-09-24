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
   * discarded the response the stream was the body of.
   */
  | "cancelled"
  /** The generator threw. What had already gone out stayed valid. */
  | "failed";

/** One finished stream. */
export interface StreamSummary {
  /**
   * Chunks the generator yielded and the stream wrote, not counting
   * keep-alives. For `sse()` that is one per event.
   */
  readonly chunks: number;

  /**
   * Bytes enqueued, keep-alives included — what the stream put on the wire
   * rather than what the application meant to say.
   */
  readonly bytes: number;

  /** How long the stream lived, in milliseconds, to the microsecond. */
  readonly durationMs: number;

  readonly reason: StreamReason;
}

/** Something written on a schedule, so an idle connection stays open. */
export interface KeepAlive {
  /** How often, in milliseconds. */
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

  /** Headers to send alongside — `cache-control`, and whatever else. */
  readonly headers?: Record<string, string>;

  /** A filler written while nothing else is. Off by default. */
  readonly keepAlive?: KeepAlive;

  /** Called once when the stream is over, with what it did. */
  readonly onEnd?: (summary: StreamSummary) => void;
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
  const encoder = new TextEncoder();
  const ending = new AbortController();
  const signal = AbortSignal.any([ctx.req.signal, ending.signal]);

  const chunks = source(signal);

  const startedAt = performance.now();

  let beating: ReturnType<typeof setInterval> | undefined;
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

  const body = new ReadableStream<Uint8Array>({
    /**
     * Starts the keep-alive, which is the only thing that writes on its
     * own schedule rather than on demand.
     *
     * It skips a beat the consumer has no room for, by the same rule the
     * chunks follow: a stream with a full queue is backed up, not idle,
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
     */
    start(controller) {
      const alive = options.keepAlive;

      if (!alive || alive.everyMs <= 0) {
        return;
      }

      beating = setInterval(() => {
        if ((controller.desiredSize ?? 0) <= 0) {
          return;
        }

        try {
          emit(controller, alive.chunk);
        } catch {
          done("cancelled");
        }
      }, alive.everyMs);
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
        reportFailure(ctx, "stream", error);

        done("failed");
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

      void chunks.return();
    },
  });

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
