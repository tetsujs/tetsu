/**
 * Server-sent events.
 *
 * ```ts
 * route({
 *   method: "GET",
 *   path: "/prices",
 *   handler: (ctx) =>
 *     sse(ctx, async function* (signal) {
 *       for await (const price of prices.watch({ signal })) {
 *         yield { data: price, id: price.at };
 *       }
 *     }),
 * });
 * ```
 *
 * The framework needs none of this to stream — a handler returning a
 * `Response` with a stream already works. What this adds is the part that
 * is easy to get quietly wrong: the wire format (a blank line ends an
 * event, and every line of a multi-line payload carries its own `data:`
 * prefix), the headers a proxy needs to see, the heartbeat that keeps an
 * idle connection from being closed by one, an `AbortSignal` that says the
 * stream is over so a source that waits can stop waiting, and the
 * backpressure that makes a slow client cost a buffer rather than a heap:
 * events are produced on demand, one at a time, at the rate they are
 * read.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import type { StreamReason, StreamSummary } from "./stream.ts";
import { interval, openStream } from "./stream.ts";

export type {
  KeepAlive,
  StreamOptions,
  StreamReason,
  StreamSummary,
} from "./stream.ts";
export { stream } from "./stream.ts";

/**
 * One event, as it goes over the wire.
 *
 * `data` is deliberately untyped. A stream usually carries several kinds
 * of event under different names, so one type parameter would be wrong for
 * all but the simplest feed — and nothing on the server consumes the
 * payload's type anyway: it leaves as JSON. A feed that is uniform can say
 * so where it is written, by typing its own generator.
 */
export interface ServerSentEvent {
  /**
   * The payload. A string is sent as it is; anything else is JSON, which
   * is what a browser's `EventSource` expects to parse. A value JSON has
   * no form for — `undefined`, a function, a symbol — is refused rather
   * than sent as an empty string: a payload that went missing, a
   * `map.get()` that found nothing, would reach the page as a valid event
   * with nothing in it.
   */
  readonly data: unknown;

  /** Event name, read by `addEventListener(name)` rather than `onmessage`. */
  readonly event?: string;

  /**
   * Event id. The browser sends the last one back as `Last-Event-ID` when
   * it reconnects, which is how a stream resumes where it stopped.
   */
  readonly id?: string | number;

  /** How long the browser waits before reconnecting, in milliseconds. */
  readonly retry?: number;
}

/** How the stream behaves. */
export interface SseOptions {
  /**
   * How often a comment line is sent to keep the connection alive, in
   * milliseconds, at most 2³¹ − 1. Defaults to 15 seconds; `0` turns it
   * off. `NaN`, `Infinity` or a negative is refused with a `TypeError`:
   * read as off, a heartbeat that `Number()` of an unset variable made
   * `NaN` would let Bun close every quiet feed without a word.
   *
   * On by default because the failure it prevents is silent and remote: a
   * proxy between the server and the browser closes a connection that has
   * been idle — nginx after 60 seconds by default — and the application
   * sees a client that keeps reconnecting for no visible reason.
   *
   * Bun closes one sooner, after 10 seconds, so the heartbeat also raises
   * its request's idle timeout above the interval — see
   * {@link KeepAlive}. Without a heartbeat, the server's `idleTimeout`
   * ends a feed that stays quiet for longer.
   */
  readonly heartbeatMs?: number;

  /** Status of the response. `200` by default. */
  readonly status?: number;

  /**
   * Ends the stream when it fires, as a client leaving would. What a
   * server that is stopping closes its streams on — see
   * {@link StreamOptions.until}.
   *
   * `draining` exists only once the server does, and the server is built
   * from the routes: the handler reads it when a request comes in, by
   * which time it is there.
   *
   * @example
   * ```ts
   * route({
   *   method: "GET",
   *   path: "/feed",
   *   handler: (ctx) => sse(ctx, feed, { until: shutdown.draining }),
   * });
   *
   * const server = Bun.serve({ ...app });
   * const shutdown = onShutdownSignals(server, { preStopDelayMs: 5_000 });
   * ```
   */
  readonly until?: AbortSignal;

  /**
   * Called once when the stream is over, with what it did — for a stream
   * that went out: one made and never sent has nothing to report.
   *
   * The gap this closes: `afterResponse` runs as the response goes to Bun,
   * which for a stream is the moment it *starts*. An
   * access log therefore records a forty-minute feed as a `200` that took
   * microseconds, and a torn connection as a success. Delivery to the
   * client is not observable in the fetch model and stays that way — but
   * the end of *generation* is, and that is what this reports.
   *
   * It carries no request id on purpose. This callback is written at the
   * call site, where `ctx` is already in scope, so the caller adds
   * whatever identifies the request better than this package could guess.
   *
   * @example
   * ```ts
   * sse(ctx, feed, {
   *   onEnd: (summary) =>
   *     logger.info({ ...summary, requestId: ctx.requestId }, "stream closed"),
   * });
   * ```
   */
  readonly onEnd?: (summary: SseSummary) => void;
}

/**
 * How an SSE stream ended — {@link StreamReason} by another name, because
 * a reader of this package should not have to go looking.
 */
export type SseReason = StreamReason;

/**
 * One finished stream, as server-sent events count it.
 *
 * The same record {@link StreamSummary} carries, with `chunks` named
 * `events`: for this helper one chunk is one event, and the word an author
 * reads at the call site should be the one they wrote.
 */
export interface SseSummary extends Omit<StreamSummary, "chunks"> {
  /** Events yielded and written, not counting heartbeats or the opening. */
  readonly events: number;
}

/**
 * Builds a server-sent events response from an async generator.
 *
 * The body opens with a comment, `: open`, which every client skips: Bun
 * sends the status and headers with the first bytes of the body, and a
 * feed with nothing to say yet would otherwise answer nothing at all.
 *
 * The headers tell a proxy what it needs to know: `cache-control:
 * no-cache`, so nothing caches a feed, and `x-accel-buffering: no`, so
 * nginx passes each event on as it is written. nginx buffers a proxied
 * response by default and held the events until its buffer filled or the
 * stream ended — a live feed that looked dead, from a server that was
 * sending. nginx reads the header and does not pass it on; other proxies
 * ignore it. A header some other proxy wants goes on `ctx.out.headers`,
 * which the framework lays over the response this returns.
 *
 * The generator is handed an `AbortSignal` that fires when the stream is
 * over, whichever way it ended — the client disconnected, the consumer
 * cancelled, the generator itself failed. It is not `ctx.req.signal`
 * directly: a source wants to know that this stream is finished, not which
 * of the ways finished it.
 *
 * **Passing it on is what makes cleanup work**, and it is the caller's job
 * rather than this package's. A generator between two `yield`s leaves on
 * its own — the loop sees the abort at the next value, ends the `for
 * await`, and the language calls the generator's `return()`, which runs
 * its `finally`. A generator parked inside an `await` is resumed by
 * nothing: `return()` on it is queued behind that `await` and applies only
 * once it settles, so an `await` on a source that has gone quiet never
 * unwinds, and the subscription inside it lives as long as the process.
 * Neither `cancel()` on the stream nor `return()` on the generator changes
 * that — both were measured, both fire, neither wakes it — which is why
 * the signal goes to the source instead.
 *
 * So the rule, stated plainly: **a stream ends with the connection if its
 * generator keeps yielding, or if it waits on the signal.** A generator
 * that does neither leaks, and no amount of care out here can collect it.
 *
 * A generator that fails instead of ending is reported — to the
 * application's `reportError`, with `source: "stream"` — and the stream is
 * closed where it stood, so what already went out stays valid and the
 * client sees an ordinary end of stream. Letting the failure escape
 * `start()` instead would reach no one the application can hear: the
 * platform prints a raw stack and tears the connection down, and whether
 * the bytes already queued are lost with it depends on whether a macrotask
 * happened to run in between.
 *
 * @example A source that yields on its own — the loop ends it.
 * ```ts
 * sse(ctx, async function* () {
 *   const subscription = topic.subscribe();
 *
 *   try {
 *     for await (const message of subscription) {
 *       yield { event: "message", data: message, id: message.id };
 *     }
 *   } finally {
 *     subscription.close();
 *   }
 * });
 * ```
 *
 * @example A source that can go quiet — it has to take the signal.
 * ```ts
 * sse(ctx, async function* (signal) {
 *   const queue = await broker.subscribe("prices", { signal });
 *
 *   try {
 *     for await (const price of queue) {
 *       yield { data: price, id: price.at };
 *     }
 *   } finally {
 *     await queue.close();
 *   }
 * });
 * ```
 */
export function sse(
  ctx: BaseCtx,
  source: (
    signal: AbortSignal,
  ) => AsyncGenerator<ServerSentEvent, void, undefined>,
  options: SseOptions = {},
): Response {
  const heartbeatMs = interval(
    "an SSE heartbeatMs",
    options.heartbeatMs ?? 15_000,
  );

  const { onEnd } = options;

  return openStream(
    ctx,
    /**
     * The only part of this helper that is about server-sent events: the
     * events become frames, and everything else — backpressure, the
     * signal, ending the generator, the summary — is the stream's.
     *
     * A `for await` rather than a manual loop, because leaving it is what
     * passes `return()` on to the source when the stream is cancelled.
     */
    async function* (signal) {
      for await (const event of source(signal)) {
        yield frame(event);
      }
    },
    {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },

      ...(options.status === undefined ? {} : { status: options.status }),

      ...(options.until === undefined ? {} : { until: options.until }),

      ...(heartbeatMs > 0
        ? { keepAlive: { everyMs: heartbeatMs, chunk: ": ping\n\n" } }
        : {}),

      ...(onEnd
        ? {
            onEnd: ({ chunks, ...rest }: StreamSummary) =>
              onEnd({ ...rest, events: chunks }),
          }
        : {}),
    },
    // A comment, which every client skips, so the headers go out now
    // rather than with the first event or heartbeat.
    ": open\n\n",
  );
}

/**
 * What ends a line for a client reading this stream.
 *
 * The protocol terminates a line on CRLF, CR or LF — all three, which is
 * why splitting the payload on `\n` alone is not enough: a lone `\r` ends
 * the field just as surely, and the rest of the value is read as a new one.
 */
const lineBreak = /\r\n|[\r\n]/;

/** What a single-line field cannot carry without ceasing to be one. */
const unrepresentable = /[\r\n\0]/;

/**
 * Formats one event.
 *
 * Every line of the payload carries its own `data:` prefix — a raw line
 * break inside one would otherwise end the field — and a blank line ends
 * the event, which is what makes the client dispatch it.
 */
export function frame(event: ServerSentEvent): string {
  const lines: string[] = [];

  if (event.event !== undefined) {
    lines.push(`event: ${single("event", event.event)}`);
  }

  if (event.id !== undefined) {
    lines.push(`id: ${single("id", String(event.id))}`);
  }

  if (event.retry !== undefined) {
    lines.push(`retry: ${reconnection(event.retry)}`);
  }

  const payload =
    typeof event.data === "string" ? event.data : JSON.stringify(event.data);

  if (payload === undefined) {
    throw new TypeError(
      `an SSE event's data has no JSON form: ${typeof event.data}`,
    );
  }

  for (const line of payload.split(lineBreak)) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}

/**
 * Checks a field the protocol gives no way to continue onto a second line.
 *
 * `data` can carry a line break because every one of its lines is prefixed
 * again; `event` and `id` cannot — the protocol has no syntax for it. So a
 * value holding one is not "an event name with a newline in it", it is a
 * second field the client will read and act on: a name the stream never
 * sent, or an id it will send back on reconnect. That is an injection, and
 * the values most likely to hold a line break are exactly the ones built
 * from outside input — a topic name, a row's key, a user's label.
 *
 * Throwing rather than stripping, for the reason the platform throws on a
 * header value with CRLF in it: a quietly rewritten id resumes the stream
 * somewhere else, and the application never learns it asked for something
 * the wire cannot carry. NUL joins them because a client drops an `id`
 * holding one, which breaks resumption just as silently.
 */
function single(field: string, value: string): string {
  if (unrepresentable.test(value)) {
    throw new TypeError(
      `an SSE ${field} cannot contain a line break or NUL: ${JSON.stringify(value)}`,
    );
  }

  return value;
}

/**
 * Checks a reconnection time: the protocol takes digits only, and a client
 * ignores anything else without a word — `NaN` from a variable that is not
 * set, a negative, a fraction. Refused, like a line break in an `id`, so
 * the stream does not go on believing it set a delay the browser threw
 * away.
 */
function reconnection(retry: number): number {
  if (!(Number.isSafeInteger(retry) && retry >= 0)) {
    throw new TypeError(
      `an SSE retry must be a whole number of milliseconds, 0 or more: ${retry}`,
    );
  }

  return retry;
}

/**
 * The id the client last received, when it is reconnecting.
 *
 * A browser sends it automatically after a dropped connection; a stream
 * that yields ids can resume from it instead of starting over.
 *
 * @example
 * ```ts
 * handler: (ctx) =>
 *   sse(ctx, async function* () {
 *     for await (const item of history.since(lastEventId(ctx))) {
 *       yield { data: item, id: item.id };
 *     }
 *   });
 * ```
 */
export function lastEventId(ctx: BaseCtx): string | undefined {
  return ctx.req.headers.get("last-event-id") ?? undefined;
}
