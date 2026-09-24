/**
 * Request logs: a line when a request arrives, and a line when it is done.
 *
 * ```ts
 * const id = requestId();
 * const arrived = arrivalLog({ write: (record) => logger.info(record, "request received") });
 * const finished = accessLog({ write: (record) => logger.info(record, "request finished") });
 *
 * createApp({
 *   hooks: { beforeParse: [id, arrived], afterResponse: [finished] },
 *   routes,
 * });
 * ```
 *
 * Two hooks, because the two lines are written at two moments, and a hook
 * package is one hook. `accessLog()` is the one most applications want:
 * one record per request, with its status and duration. `arrivalLog()` is
 * for the request that never gets that record — a handler that hangs, a
 * process that dies half-way — where the line of its arrival is the only
 * trace that it came at all. It doubles the lines, so it is mounted only
 * where that trace is wanted: behind a proxy that already logs arrivals it
 * is not.
 *
 * Both records keep to the same rules. No headers, no bodies, no query
 * string, and no option to add them: nothing sensitive has to be stripped
 * from a place it is never put. `path` is the pathname alone. A
 * `requestId` is on the record when `requestId()` from
 * `@tetsujs/request-id` ran before the hook that writes it — read at
 * runtime rather than required in the types, so either log works without
 * it.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { hook } from "@tetsujs/core";

/** How a record is written. */
export interface LogOptions<Record> {
  /**
   * Where the line goes. `console.log` by default.
   *
   * Takes the record rather than a string so a structured logger can be
   * handed the fields as they are.
   */
  readonly write?: (record: Record) => void;
}

/** One request, as it arrives. */
export interface ArrivalRecord {
  readonly method: string;

  /** The path that was asked for: the pathname, never the query. */
  readonly path: string;

  readonly requestId?: string;
}

/** The hook {@link arrivalLog} returns. */
export type ArrivalLogHook = ReturnType<typeof arrivalLog>;

/** The hook {@link accessLog} returns. */
export type AccessLogHook = ReturnType<typeof accessLog>;

/** How an access record is written. */
export type AccessLogOptions = LogOptions<AccessRecord>;

/** How an arrival record is written. */
export type ArrivalLogOptions = LogOptions<ArrivalRecord>;

/**
 * Writes a line for every request as it arrives, before anything can
 * refuse it or hang on it.
 *
 * A `beforeParse` hook, so the line is written on the request's own path
 * rather than after the response: a writer that blocks delays the
 * request, and a logger that buffers — pino, for one — is the kind to
 * hand it.
 *
 * Where it sits in `beforeParse` decides what it sees. After
 * `requestId()`, the record carries the id. After `cors()`, a preflight
 * is answered before this hook runs and gets no line; before it, it does.
 *
 * @example
 * ```ts
 * const arrived = arrivalLog({ write: (record) => logger.info(record, "request received") });
 *
 * createApp({ hooks: { beforeParse: [id, arrived] }, routes });
 * ```
 */
export function arrivalLog(options: ArrivalLogOptions = {}) {
  const write =
    options.write ?? ((record: ArrivalRecord) => console.log(record));

  return hook.beforeParse((ctx) => {
    const id = requestIdOf(ctx);

    write({
      method: ctx.req.method,
      path: new URL(ctx.req.url).pathname,
      ...(id === undefined ? {} : { requestId: id }),
    });
  });
}

/** One finished request. */
export interface AccessRecord {
  readonly method: string;

  /** The path that was asked for, identifiers and all. */
  readonly path: string;

  /**
   * The route that answered, as it was declared — `/users/:id` where
   * `path` is `/users/42`.
   *
   * Absent when nothing matched, which is the honest answer for a `404`
   * and the one that keeps it countable on its own rather than folded in
   * with the endpoints that exist. Both fields are here because they
   * answer different questions: `path` is what the client asked for, and
   * on a `404` it is the only interesting thing in the line; `route` is
   * what the application did, and it is the one a dashboard can group by
   * without growing a series per identifier.
   */
  readonly route?: string;

  readonly status: number;

  /**
   * How long the request took inside the pipeline, in milliseconds,
   * rounded to the microsecond.
   *
   * From `ctx.startedAt`, which the core reads before any hook, to
   * `afterResponse`: the response is handed to the runtime before
   * `afterResponse` runs, so writing it to the socket is not in here, and
   * neither is anything that happened before the pipeline started.
   */
  readonly durationMs: number;

  /**
   * The name of whatever was thrown, when something was.
   *
   * `"ValidationError"`, `"HttpError"`, `"TypeError"` — the class, never
   * the message. A message is written by the application and routinely
   * carries the very thing that must not reach a log store: the token that
   * failed to verify, the address that was not found. The whole error,
   * stack and all, goes to the application's `reportError` with the
   * request's context; a record whose job is to be shipped somewhere keeps
   * to the shape of the failure, and `requestId` — in both — joins the
   * two.
   *
   * Named `thrown` rather than `error` on purpose: `error` in this
   * framework is the machine-readable code in the response envelope
   * (`NOT_FOUND`), and two different things under one name in a log store
   * is a confusion nobody untangles later.
   */
  readonly thrown?: string;

  readonly requestId?: string;
}

/**
 * Observes every finished request, successes and failures alike.
 *
 * `afterResponse` runs outside the client's latency, so a slow writer
 * delays nothing — and it runs on every outcome, which is what makes the
 * log complete rather than only the happy path.
 *
 * The line carries both the path asked for and the route that answered,
 * because a `404` has only the first and a dashboard can only group by the
 * second.
 *
 * @example
 * ```ts
 * const log = accessLog({ write: (record) => logger.info(record) });
 * ```
 */
export function accessLog(options: AccessLogOptions = {}) {
  const write =
    options.write ?? ((record: AccessRecord) => console.log(record));

  return hook.afterResponse((ctx) => {
    const carrying = ctx as BaseCtx & {
      readonly res: Response;
      readonly error?: unknown;
    };
    const id = requestIdOf(ctx);

    write({
      method: ctx.req.method,
      path: new URL(ctx.req.url).pathname,
      ...(ctx.route === undefined ? {} : { route: ctx.route.path }),
      status: carrying.res.status,
      durationMs: elapsed(ctx.startedAt),
      ...("error" in carrying ? { thrown: nameOf(carrying.error) } : {}),
      ...(id === undefined ? {} : { requestId: id }),
    });
  });
}

/**
 * Milliseconds since a monotonic reading, to the microsecond.
 *
 * Rounded because the raw subtraction carries a dozen digits the clock
 * does not have, and a log store keeps every one of them.
 */
function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

/**
 * Names a thrown value without quoting it.
 *
 * An `Error` answers with its class. Anything else — a thrown string, a
 * rejected object — answers with its type alone, because the value itself
 * is the part that may carry a secret, and this field says what kind of
 * failure happened rather than reproducing it.
 */
function nameOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : typeof thrown;
}

/**
 * The id `requestId()` put on the context, when it ran before the hook
 * asking. Read at runtime: requiring it in the types would make either
 * log unusable without that hook, and both are useful on their own.
 */
function requestIdOf(ctx: BaseCtx): string | undefined {
  const id = (ctx as BaseCtx & { readonly requestId?: unknown }).requestId;

  return typeof id === "string" ? id : undefined;
}
