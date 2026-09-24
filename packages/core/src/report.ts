/**
 * Where the failures nobody can answer go.
 *
 * `onError` turns an error into a response. What is left over has no
 * response to become: an `afterResponse` observer that threw after the
 * response had gone, an `onError` hook that failed in turn, a WebSocket
 * handler, a stream whose generator broke mid-body, an error no hook
 * mapped. The framework used to print those on `console.error`, whole —
 * past the application's logger, its redaction and its request ids. A
 * database error carrying the query and its parameters in `message` went
 * to stdout as it was.
 *
 * Now they go through one function the application passes to
 * `createApp({ reportError })`. It gets a structured report — what failed,
 * the error untouched, and the request's context when there was a request
 * — and decides what that becomes: a log line, a Sentry event, a counter.
 * Without one, the report is printed as before.
 *
 * Named after the platform's own `reportError()`, the global for an error
 * nobody can handle, and not an `onError`: that name belongs to the hook
 * slot that answers, and two `onError`s with different jobs would be read
 * as one.
 *
 * Rejected: taking a logger, the way Fastify and Nest do. The framework
 * writes no information lines of its own, only failures, and an interface
 * with levels would be a contract for output it does not produce — and a
 * shape every logger has to be adapted to.
 *
 * @module
 */

import type { BaseCtx } from "./context.ts";
import { isThenable } from "./internal.ts";

/**
 * What failed, as a code to branch on.
 *
 * The framework's own values are listed so an editor offers them; the
 * type stays open because a package reporting through
 * {@link reportFailure} names its own.
 *
 * | | |
 * | --- | --- |
 * | `unhandled` | an error no `onError` hook answered, and not an `HttpError`: the request got a `500` |
 * | `response` | a handler broke its response contract — a status its map does not declare, a body its schema rejects |
 * | `onError` | an `onError` hook threw; the next one, or the default mapping, answered instead |
 * | `errorResponse` | the error path failed in turn, and the request got a bare `500` |
 * | `afterResponse` | an `afterResponse` observer threw; the response had already gone |
 * | `websocket` | a WebSocket handler threw, or a message schema failed rather than rejecting |
 * | `stream` | a streamed body's source threw, or its `onEnd` did (`@tetsujs/sse`) |
 * | `shutdown` | a closer threw while the process was stopping (`@tetsujs/lifecycle`) |
 */
export type FailureSource =
  | "unhandled"
  | "response"
  | "onError"
  | "errorResponse"
  | "afterResponse"
  | "websocket"
  | "stream"
  | "shutdown"
  | (string & {});

/**
 * One failure the framework could not answer.
 *
 * @typeParam Ctx - The request's context as the application sees it: the
 * base fields, plus whatever its own hooks contribute, each optional —
 * the failure may have come before the hook ran.
 */
export interface FailureReport<Ctx extends object = BaseCtx> {
  readonly source: FailureSource;

  /**
   * What was thrown, exactly as it was thrown: not formatted, not
   * truncated, so a logger's redaction sees the fields it knows.
   */
  readonly error: unknown;

  /**
   * The context of the request the failure belongs to.
   *
   * Absent where there is no request: a WebSocket event, a shutdown.
   */
  readonly ctx?: Ctx;
}

/**
 * The application's receiver for {@link FailureReport}s.
 *
 * Called in place, and never awaited: the error path must not wait on a
 * log shipper, and an observer's failure must not become the client's
 * latency. A receiver that throws, or returns a promise that rejects, is
 * reported on `console.error` together with the failure it was handed —
 * the one place left to put it.
 */
export type ReportError<Ctx extends object = BaseCtx> = (
  report: FailureReport<Ctx>,
) => unknown;

/**
 * The receiver as the framework calls it: never throws, whatever the
 * application's does.
 *
 * `label` is the line printed when the report ends up on the console —
 * more specific than the source where the framework knows more, such as
 * which WebSocket event failed. It never reaches the application's
 * receiver, which has the error itself. Internal to the core.
 */
export type Reporter = (report: FailureReport<object>, label?: string) => void;

/**
 * Where a request's context keeps its application's reporter.
 *
 * A symbol, so it is in no type and in no `Object.keys`: a hook cannot
 * overwrite it by returning an object, and a socket's copy of the context
 * does not carry it. Internal to the core.
 */
export const reporterKey: unique symbol = Symbol("tetsu.reporter");

/**
 * Builds the reporter an application runs with.
 *
 * Without a receiver, reports are printed exactly as the framework always
 * printed them, so an application that passes nothing sees no change.
 */
export function reporter(receive: ReportError<never> | undefined): Reporter {
  if (receive === undefined) {
    return print;
  }

  const deliver = receive as ReportError<object>;

  return (report, label) => {
    let outcome: unknown;

    try {
      outcome = deliver(report);
    } catch (failure) {
      receiverFailed(report, failure, label);

      return;
    }

    if (isThenable(outcome)) {
      outcome.then(undefined, (failure: unknown) =>
        receiverFailed(report, failure, label),
      );
    }
  };
}

/**
 * Reports a failure the code at hand cannot answer, to the application's
 * receiver — the way a package does what the framework does itself.
 *
 * `ctx` is any context the pipeline handed out: a hook's, a handler's, a
 * stream's. A context built outside a request, such as `testCtx()` in a
 * unit test, has no application behind it, and the report is printed.
 *
 * @example A stream that broke after its response had gone
 * ```ts
 * try {
 *   yield* source;
 * } catch (error) {
 *   reportFailure(ctx, "stream", error);
 * }
 * ```
 */
export function reportFailure(
  ctx: BaseCtx,
  source: FailureSource,
  error: unknown,
): void {
  const report =
    (ctx as { readonly [reporterKey]?: Reporter })[reporterKey] ?? print;

  report({ source, error, ctx });
}

/**
 * What a report is printed as without a receiver: one `console.error`
 * call, prefixed so it can be found.
 */
function print(report: FailureReport<object>, label?: string): void {
  const { error } = report;

  if (error instanceof ResponseContractError) {
    printContract(error);

    return;
  }

  console.error(
    `[tetsu] ${label ?? labels[report.source] ?? report.source}:`,
    error,
  );
}

/**
 * A broken response contract is printed as the finding it is, not as a
 * stack: which status was refused, or which issues the schema raised.
 */
function printContract(error: ResponseContractError): void {
  if (error.issues === undefined) {
    console.error(`[tetsu] ${error.message}`);

    return;
  }

  console.error(`[tetsu] ${error.message}:`, error.issues);
}

function receiverFailed(
  report: FailureReport<object>,
  failure: unknown,
  label: string | undefined,
): void {
  console.error("[tetsu] reportError failed:", failure);

  print(report, label);
}

/** The printed line for each of the framework's own sources. */
const labels: Record<string, string> = {
  unhandled: "Unhandled error",
  onError: "onError hook failed",
  errorResponse: "Error response failed",
  afterResponse: "afterResponse hook failed",
  websocket: "websocket handler failed",
  stream: "stream failed",
  shutdown: "shutdown step failed",
};

/**
 * A handler answered with something its response contract does not allow:
 * a status the map does not declare, or a body its schema rejects.
 *
 * The client gets a `500` and nothing of the body, and the application
 * gets one report with `source: "response"` — a bug in the application,
 * worth telling apart from a database that went away. `issues` carries
 * what the schema found; the validator writes them, and some validators
 * quote the rejected value, which is why they sit in a field of their own
 * that a logger can drop rather than in the message.
 */
export class ResponseContractError extends Error {
  readonly issues?: readonly unknown[] | undefined;

  constructor(message: string, issues?: readonly unknown[]) {
    super(message);

    this.name = "ResponseContractError";
    this.issues = issues;
  }
}
