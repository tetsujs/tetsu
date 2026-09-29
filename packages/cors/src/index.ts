/**
 * CORS as one hook.
 *
 * Nothing is registered and nothing is patched: `cors()` returns a
 * `beforeParse` hook, and the application puts it where every other hook
 * goes. That is the whole shape of a hook package here — a function that
 * returns a hook.
 *
 * ```ts
 * const browser = cors({ origin: "https://app.example.com" });
 *
 * createApp({
 *   hooks: { beforeParse: [browser, requestId] },
 *   routes,
 * });
 * ```
 *
 * One hook does both halves of the job. A preflight is answered from
 * `beforeParse`, before any hook after it — an authentication hook, a rate
 * limit — can refuse a request that carries no credentials by design. And
 * every other request gets its headers in `ctx.out`, which the core lays
 * over whatever response leaves, errors and the `404` included.
 *
 * **Mount it before every hook that can refuse.** A hook before it that
 * answers on its own — a rate limit refusing — answers before the headers
 * are written, and the browser cannot read that answer. A hook that never
 * refuses — `requestId()`, `arrivalLog()` — may come before it, and then
 * a preflight gets its id and its log line as well.
 *
 * **Mount it on the application, not on a group.** Group hooks do not run
 * on protocol responses — `404`, `405` and the `OPTIONS` preflight — which
 * is a deliberate, documented limit of the core; a zone-level CORS would
 * therefore go missing on exactly the preflight it exists for.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { hook } from "@tetsujs/core";

/** How the browser is answered. */
export interface CorsOptions {
  /**
   * Which origins are allowed.
   *
   * A list is matched exactly and echoed back — echoing rather than
   * returning the list is what the header format requires. `"*"` allows
   * every origin, and is refused together with `credentials`, which the
   * specification does not permit.
   *
   * An origin is written as a browser sends it — scheme, host and port,
   * nothing after: `https://app.example.com`. Anything else never matches,
   * so it is refused where it is written, naming the origin it means: a
   * trailing slash, capitals, a path, a default port. `"null"` — what a
   * sandboxed frame or a `file:` page sends — is taken as it is, and
   * refused with `credentials`: any site can send it.
   */
  readonly origin: string | readonly string[] | "*";

  /** Methods advertised on a preflight. Defaults to the usual five. */
  readonly methods?: readonly string[];

  /** Request headers a browser may send. Defaults to the usual two. */
  readonly headers?: readonly string[];

  /** Response headers a browser may read. Empty by default. */
  readonly exposeHeaders?: readonly string[];

  /** Whether credentials may be sent. Off by default. */
  readonly credentials?: boolean;

  /** How long a preflight may be cached, in seconds. Defaults to a day. */
  readonly maxAge?: number;
}

/**
 * The hook of this package.
 *
 * Read off `cors()` rather than written by hand, and that is the point: an
 * annotation of `AnyHook` would erase which slot the hook belongs to, and
 * the stack validation would then reject the very hook it was handed.
 */
export type CorsHook = ReturnType<typeof cors>;

const defaultMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const defaultHeaders = ["content-type", "authorization"] as const;

/**
 * Builds the CORS hook.
 *
 * The headers are written to `ctx.out.headers` rather than onto a
 * rebuilt response: those are applied to *every* outgoing response,
 * errors and short-circuits included, so a rejected request stays
 * readable by the browser that made it. Rebuilding the response would
 * both cost a copy and miss the responses that never pass through the
 * handler.
 *
 * @example
 * ```ts
 * const browser = cors({ origin: ["https://app.example.com"], credentials: true });
 * ```
 */
export function cors(options: CorsOptions) {
  if (options.origin === "*" && options.credentials) {
    throw new Error(
      'CORS: origin "*" cannot be combined with credentials — a browser refuses that pair, so the request would fail at the client instead of here',
    );
  }

  const listed =
    options.origin === "*"
      ? []
      : typeof options.origin === "string"
        ? [options.origin]
        : options.origin;

  for (const origin of listed) {
    assertOrigin(origin);
  }

  if (options.credentials && listed.includes("null")) {
    throw new Error(
      'CORS: origin "null" cannot be combined with credentials — a sandboxed frame, a data: or file: page, a redirect all send it, and any site can put itself in one, so the pair lets any site make credentialed requests and read the answers',
    );
  }

  // A response that depends on the origin says so on every answer — the
  // ones without CORS headers too: a shared cache that stored one of those
  // as the same for everyone handed it to an allowed site, whose browser
  // then refused it. A wildcard answers everyone alike, and varies by
  // nothing.
  const varies = options.origin !== "*";

  const methods = (options.methods ?? defaultMethods).join(", ");
  const headers = (options.headers ?? defaultHeaders).join(", ");
  const maxAge = String(options.maxAge ?? 86_400);

  const allowedOrigin = (ctx: BaseCtx): string | undefined => {
    const origin = ctx.req.headers.get("origin");

    if (!origin) {
      return undefined;
    }

    if (options.origin === "*") {
      return "*";
    }

    const allowed =
      typeof options.origin === "string" ? [options.origin] : options.origin;

    return allowed.includes(origin) ? origin : undefined;
  };

  /**
   * Writes the headers every CORS response carries, once per request.
   */
  const write = (ctx: BaseCtx, origin: string): void => {
    ctx.out.headers.set("access-control-allow-origin", origin);

    if (options.credentials) {
      ctx.out.headers.set("access-control-allow-credentials", "true");
    }

    if (options.exposeHeaders && options.exposeHeaders.length > 0) {
      ctx.out.headers.set(
        "access-control-expose-headers",
        options.exposeHeaders.join(", "),
      );
    }
  };

  return hook.beforeParse((ctx) => {
    if (varies) {
      ctx.out.headers.append("vary", "origin");
    }

    const origin = allowedOrigin(ctx);

    if (!origin) {
      return undefined;
    }

    write(ctx, origin);

    if (ctx.req.method !== "OPTIONS") {
      return undefined;
    }

    ctx.out.headers.set("access-control-allow-methods", methods);
    ctx.out.headers.set("access-control-allow-headers", headers);
    ctx.out.headers.set("access-control-max-age", maxAge);

    return new Response(null, { status: 204 });
  });
}

/**
 * Refuses an origin a browser would never send, naming the one it means.
 *
 * The request's `Origin` is compared as it arrives, and a browser sends it
 * one way only: lowercase, no path, no trailing slash, no default port.
 * Written any other way — copied from an address bar, typed with a
 * capital — it never matched, and every request from the site was refused
 * with nothing at startup to say why. A wildcard never matched either:
 * origins are compared whole.
 *
 * Only the schemes the URL standard knows how to normalize are read with
 * `URL` — `http`, `https`, `ws`, `wss`, `ftp`. For any other, `URL` says
 * the origin is `"null"`, and yet browsers send such origins as they are:
 * `chrome-extension://…`, `capacitor://localhost`, `tauri://localhost`.
 * Those are taken as written, in lowercase, with nothing after the host.
 */
function assertOrigin(origin: string): void {
  if (origin === "null") {
    return;
  }

  if (origin.toLowerCase() === "null" || origin === "*") {
    throw new Error(
      origin === "*"
        ? 'CORS: "*" in a list is compared as a string and never matches — to allow every origin, pass origin: "*" itself'
        : `CORS: "${origin}" is not what a browser sends — the opaque origin is "null", in lowercase`,
    );
  }

  if (origin.includes("*")) {
    throw new Error(
      `CORS: "${origin}" is a pattern, and origins are matched whole — list each origin that is allowed`,
    );
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(origin)?.[1];

  if (scheme !== undefined && !special.has(scheme.toLowerCase())) {
    const meant = origin.toLowerCase();

    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/.test(origin)) {
      return;
    }

    throw new Error(
      /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/.test(meant)
        ? `CORS: "${origin}" is not an origin as a browser sends it, and would never match — did you mean "${meant}"?`
        : `CORS: "${origin}" is not an origin — a scheme and a host, with nothing after: "capacitor://localhost"`,
    );
  }

  let meant: string | undefined;

  try {
    meant = new URL(origin).origin;
  } catch {
    meant = undefined;
  }

  if (meant === origin) {
    return;
  }

  throw new Error(
    meant === undefined || meant === "null"
      ? `CORS: "${origin}" is not an origin — an origin is a scheme, a host and a port, as a browser sends it: "https://app.example.com"`
      : `CORS: "${origin}" is not an origin as a browser sends it, and would never match — did you mean "${meant}"?`,
  );
}

/** The schemes whose origins the URL standard normalizes. */
const special = new Set(["http", "https", "ws", "wss", "ftp"]);
