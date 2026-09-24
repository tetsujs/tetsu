/**
 * A request id and an access log — the pair that makes a log line
 * traceable.
 *
 * ```ts
 * const tracing = requestId();
 * const log = accessLog();
 *
 * createApp({ hooks: [tracing, log], routes });
 * ```
 *
 * This is the package that shows a **typed contribution**: `requestId()`
 * puts `ctx.requestId` into the context, and a route that mounts it sees
 * it as a `string` without anyone annotating anything.
 *
 * Mounted on the application, as above, the field is there at runtime but
 * not in the types of a route's handler — an application does not know
 * which routes it will hold, so it cannot type them, the same reason a
 * group cannot. Two ways to read it typed: mount the hook on the route
 * that needs it, or declare the requirement with `Requires<{ requestId:
 * string }>` on the hook that reads it, which the core then checks.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { hook } from "@tetsujs/core";

/** How the id is obtained and where it is written. */
export interface RequestIdOptions {
  /**
   * The header the id is written to, and read from when trusted.
   * Defaults to `x-request-id`.
   */
  readonly header?: string;

  /**
   * Whether an incoming header is trusted.
   *
   * Off by default, and deliberately: an id from the outside is a value a
   * client chose, so trusting it lets one client stamp another's log
   * lines. Turn it on only behind a proxy that overwrites the header.
   * An empty header counts as none, and the id is generated.
   */
  readonly trustIncoming?: boolean;

  /** How an id is made. `crypto.randomUUID()` by default. */
  readonly generate?: () => string;
}

/**
 * The hooks of this package, ready to be spread into an application's own.
 *
 * Read off the factory rather than written by hand: an annotation of
 * `AnyHook` would erase both the slot and the contribution, and the stack
 * validation would reject the hooks it was handed.
 */
export type RequestIdHooks = ReturnType<typeof requestId>;

/** The hooks of {@link accessLog}. */
export type AccessLogHooks = ReturnType<typeof accessLog>;

/**
 * Gives every request an id, in the context and on the response.
 *
 * @example
 * ```ts
 * const tracing = requestId({ trustIncoming: true });
 *
 * route({
 *   method: "GET",
 *   path: "/orders",
 *   handler: (ctx) => logger.info({ requestId: ctx.requestId }, "listing"),
 *   //                                    ^? string
 * });
 * ```
 */
export function requestId(options: RequestIdOptions = {}) {
  const header = options.header ?? "x-request-id";
  const generate = options.generate ?? (() => crypto.randomUUID());

  const stamp = hook.beforeParse((ctx) => {
    const incoming = options.trustIncoming ? ctx.req.headers.get(header) : null;

    const id = incoming || generate();

    ctx.out.headers.set(header, id);

    return { requestId: id };
  });

  return { beforeParse: [stamp] } as const;
}

/** What a finished request is written as. */
export interface AccessLogOptions {
  /**
   * Where the line goes. `console.log` by default.
   *
   * Takes the record rather than a string so a structured logger can be
   * handed the fields as they are.
   */
  readonly write?: (record: AccessRecord) => void;
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
   * From the first `beforeParse` hook to `afterResponse`, which is the
   * span this package can see: the response is handed to the runtime
   * before `afterResponse` runs, so writing it to the socket is not in
   * here, and neither is anything that happened before the pipeline
   * started.
   *
   * Absent when only the `afterResponse` half of this package is mounted,
   * because then nothing started the clock — spread both slots.
   */
  readonly durationMs?: number;

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

  const clock = hook.beforeParse(() => ({ startedAt: performance.now() }));

  const observe = hook.afterResponse((ctx) => {
    const carrying = ctx as BaseCtx & {
      readonly res: Response;
      readonly requestId?: unknown;
      readonly startedAt?: unknown;
      readonly error?: unknown;
    };

    write({
      method: ctx.req.method,
      path: new URL(ctx.req.url).pathname,
      ...(ctx.route === undefined ? {} : { route: ctx.route.path }),
      status: carrying.res.status,
      ...(typeof carrying.startedAt === "number"
        ? { durationMs: elapsed(carrying.startedAt) }
        : {}),
      ...("error" in carrying ? { thrown: nameOf(carrying.error) } : {}),
      ...(typeof carrying.requestId === "string"
        ? { requestId: carrying.requestId }
        : {}),
    });
  });

  return { beforeParse: [clock], afterResponse: [observe] } as const;
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
