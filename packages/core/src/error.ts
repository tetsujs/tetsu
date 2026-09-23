/**
 * Errors the pipeline maps to responses.
 *
 * Anything thrown from a hook or a handler travels through the `onError`
 * chain and then to the default mapper: `HttpError` becomes its status and
 * body, everything else becomes an opaque `500`.
 *
 * Every failure the framework itself produces leaves in one shape — the
 * {@link ErrorBody} envelope — so a client can branch on a single field
 * across every status, and a logger can print one line for all of them.
 *
 * @module
 */

/**
 * The envelope every framework-produced failure is serialized as.
 *
 * `status` repeats the HTTP status inside the body: a client that only
 * kept the parsed payload — a log line, a queued retry record, a rejected
 * promise passed up a call stack — still knows what happened without the
 * `Response` it came from.
 *
 * `error` is the machine-readable code, `UPPER_SNAKE_CASE`, and the field
 * to branch on. `message` is human-readable and may be reworded at any
 * time; never match on it.
 */
export interface ErrorBody {
  readonly status: number;
  readonly message: string;
  readonly error: string;
}

/**
 * Builds the {@link ErrorBody} envelope for a status.
 *
 * Both halves default to the status itself: `errorBody(404)` is
 * `{ status: 404, message: "Not Found", error: "NOT_FOUND" }`. Pass
 * `error` when the failure is more specific than its status —
 * `MALFORMED_JSON` rather than a bare `BAD_REQUEST` — and `message` when
 * the reason phrase would not tell a developer what to fix.
 *
 * Exported for hooks that answer with a `Response` of their own instead of
 * throwing, and for applications that want their failures to look like the
 * framework's.
 *
 * @example
 * ```ts
 * return Response.json(
 *   { ...errorBody(429, "RATE_LIMITED"), retryAfter },
 *   { status: 429 },
 * );
 * ```
 */
export function errorBody(
  status: number,
  error?: string,
  message?: string,
): ErrorBody {
  return {
    status,
    message: message ?? reasonPhrase(status),
    error: error ?? codes[status] ?? toCode(reasonPhrase(status)),
  };
}

/**
 * Creates an {@link HttpError} whose body is the {@link ErrorBody}
 * envelope — the throwing counterpart of {@link errorBody}, and how the
 * framework raises every failure of its own.
 *
 * @example
 * ```ts
 * if (!session) throw httpError(401, "SESSION_EXPIRED", "Session expired");
 * ```
 */
export function httpError(
  status: number,
  error?: string,
  message?: string,
): HttpError {
  return new HttpError(status, errorBody(status, error, message));
}

/**
 * An HTTP-mapped error: thrown from any lifecycle stage or handler, caught
 * by the pipeline and turned into a response with the given status.
 *
 * Business status codes are entirely the caller's decision — the framework
 * never picks them.
 *
 * What reaches the client depends on `body`. Omitted, it is the
 * {@link ErrorBody} envelope for the status; a string replaces the
 * envelope's `message`; anything else is serialized verbatim, because a
 * body you wrote is a contract the framework has no business rewriting.
 *
 * @example
 * ```ts
 * // { status: 404, message: "Not Found", error: "NOT_FOUND" }
 * if (!order) throw new HttpError(404);
 *
 * // { status: 403, message: "Not your order", error: "FORBIDDEN" }
 * if (order.ownerId !== ctx.user.id) throw new HttpError(403, "Not your order");
 *
 * // { status: 409, message: "Order already shipped", error: "ALREADY_SHIPPED" }
 * if (order.shipped) throw httpError(409, "ALREADY_SHIPPED", "Order already shipped");
 * ```
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, body?: unknown) {
    super(errorMessage(status, body));

    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The `Error.message` of an `HttpError` — what a stack trace and a log
 * line show, never what the client is sent.
 *
 * A string body is the message. So is a `message` a body object carries,
 * envelope or not: an error logged as `Error: Not Found` when its body
 * says "no session for this cookie" wastes the one line most log viewers
 * show. The reason phrase is the fallback.
 */
function errorMessage(status: number, body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  const message = (body as { message?: unknown } | null | undefined)?.message;

  return typeof message === "string" ? message : reasonPhrase(status);
}

/**
 * What an `HttpError` serializes as: its own body when it carries one, the
 * envelope otherwise.
 *
 * Internal to the core — the single place the rule documented on
 * {@link HttpError} is applied.
 */
export function serializedBody(error: HttpError): unknown {
  if (error.body === undefined) {
    return errorBody(error.status);
  }

  if (typeof error.body === "string") {
    return errorBody(error.status, undefined, error.body);
  }

  return error.body;
}

/**
 * One rejected value reported by a schema.
 *
 * `path` locates the value, starting with the request part it came from:
 * `["body", "items", 0, "name"]`. `message` is written by the validator, so
 * its wording differs between Zod, Valibot, TypeBox and the rest — clients
 * should branch on `path`, never on the text.
 */
export interface ValidationIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/**
 * Schema validation rejected the request.
 *
 * Thrown by the pipeline after running every declared schema, carrying the
 * issues of all request parts at once. Serializes as the {@link ErrorBody}
 * envelope with `error: "VALIDATION_FAILED"` and an added `issues` array,
 * under the configured validation status (`422` by default).
 *
 * Catch it in an `onError` hook to replace the format wholesale — a
 * problem+json envelope, a translated message table, or a response that
 * omits validator wording entirely.
 *
 * @example Replacing the envelope for the whole application
 * ```ts
 * const asProblemDetails = hook.onError((ctx) =>
 *   ctx.error instanceof ValidationError
 *     ? Response.json(
 *         {
 *           title: "Validation failed",
 *           status: ctx.error.status,
 *           errors: ctx.error.issues.map((issue) => ({
 *             pointer: `/${issue.path.join("/")}`,
 *           })),
 *         },
 *         {
 *           status: ctx.error.status,
 *           headers: { "content-type": "application/problem+json" },
 *         },
 *       )
 *     : undefined,
 * );
 *
 * createApp({ hooks: { onError: [asProblemDetails] }, routes });
 * ```
 */
export class ValidationError extends HttpError {
  readonly issues: readonly ValidationIssue[];

  constructor(status: number, issues: readonly ValidationIssue[]) {
    super(status, {
      ...errorBody(status, "VALIDATION_FAILED", "Validation failed"),
      issues,
    });

    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * The reason phrases of RFC 9110 and its neighbours, the source of both
 * halves of a default envelope: the phrase is the `message`, and its
 * `UPPER_SNAKE_CASE` form is the `error` code.
 *
 * Deriving the code instead of listing it keeps the two from drifting
 * apart, and gives a status outside the table — a private code an
 * application picked — the same treatment: `HTTP 499` becomes `HTTP_499`.
 */
const phrases: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

function reasonPhrase(status: number): string {
  return phrases[status] ?? `HTTP ${status}`;
}

/**
 * Turns a reason phrase into its code: apostrophes vanish, every other
 * run of non-alphanumerics becomes a single underscore. `I'm a Teapot`
 * becomes `IM_A_TEAPOT`, not `I_M_A_TEAPOT`.
 */
function toCode(phrase: string): string {
  return phrase
    .replace(/'/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

const codes: Record<number, string> = Object.fromEntries(
  Object.entries(phrases).map(([status, phrase]) => [status, toCode(phrase)]),
);
