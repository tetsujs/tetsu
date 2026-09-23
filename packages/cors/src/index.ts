/**
 * CORS as a pair of hooks.
 *
 * Nothing is registered and nothing is patched: `cors()` returns hooks,
 * and the application puts them where every other hook goes. That is the
 * whole shape of a hook package here — an object with a tuple per slot,
 * spread into the application's own tuples.
 *
 * ```ts
 * const shared = cors({ origin: "https://app.example.com" });
 *
 * createApp({
 *   hooks: [shared, { beforeParse: [requestId] }],
 *   routes,
 * });
 * ```
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
 * The hooks of this package, ready to be spread into an application's own.
 *
 * Read off `cors()` rather than written by hand, and that is the point: an
 * annotation of `AnyHook` would erase which slot each hook belongs to, and
 * the stack validation would then reject the very hooks it was handed —
 * the same widening that a hook array declared as `Hook[]` suffers.
 */
export type CorsHooks = ReturnType<typeof cors>;

const defaultMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const defaultHeaders = ["content-type", "authorization"] as const;

/**
 * Builds the CORS hooks.
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
 * const shared = cors({ origin: ["https://app.example.com"], credentials: true });
 * ```
 */
export function cors(options: CorsOptions) {
  if (options.origin === "*" && options.credentials) {
    throw new Error(
      'CORS: origin "*" cannot be combined with credentials — a browser refuses that pair, so the request would fail at the client instead of here',
    );
  }

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
   * Writes the headers every CORS response carries.
   *
   * Only from `beforeResponse`: that slot sees every outgoing response,
   * the preflight short-circuit included, so writing them here once is
   * both complete and free of duplicates — `vary` would otherwise be
   * appended twice for one request.
   */
  const write = (ctx: BaseCtx, origin: string): void => {
    ctx.out.headers.set("access-control-allow-origin", origin);

    if (origin !== "*") {
      ctx.out.headers.append("vary", "origin");
    }

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

  const preflight = hook.beforeParse((ctx) => {
    if (ctx.req.method !== "OPTIONS" || !allowedOrigin(ctx)) {
      return undefined;
    }

    ctx.out.headers.set("access-control-allow-methods", methods);
    ctx.out.headers.set("access-control-allow-headers", headers);
    ctx.out.headers.set("access-control-max-age", maxAge);

    return new Response(null, { status: 204 });
  });

  const decorate = hook.beforeResponse((ctx) => {
    const origin = allowedOrigin(ctx);

    if (origin) {
      write(ctx, origin);
    }

    return undefined;
  });

  return { beforeParse: [preflight], beforeResponse: [decorate] } as const;
}
