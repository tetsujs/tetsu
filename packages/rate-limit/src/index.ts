/**
 * Rate limiting as a hook.
 *
 * ```ts
 * const limit = rateLimit({
 *   limit: 60,
 *   windowMs: 60_000,
 *   key: (ctx) => ctx.server.requestIP(ctx.req)?.address ?? undefined,
 * });
 *
 * createApp({ hooks: { beforeParse: [limit] }, routes });
 * ```
 *
 * The refusal is a returned `Response`, not a thrown `HttpError`. Both
 * reach the client identically, but throwing costs 3.1–3.2× as much
 * through the pipeline — measured, `bench/src/refusal.ts` — and a limiter
 * refuses in bulk, by design. Where rejection is the hot path, return.
 *
 * Not because the error captures a stack: building an `HttpError` is a few
 * percent *cheaper* than building a `Response`. The cost is unwinding, and
 * then the distance the error path covers that a short-circuit does not.
 *
 * The hook is annotated with what it answers, so a generated document says
 * `429` on every operation it guards without the routes repeating it.
 *
 * @module
 */

import type { BaseCtx } from "@tetsujs/core";
import { errorBody, hook } from "@tetsujs/core";
import { documented } from "@tetsujs/openapi";
import type { RateLimitStore } from "./store.ts";
import { memoryStore } from "./store.ts";

export type { RateLimitStore, WindowState } from "./store.ts";
export { memoryStore } from "./store.ts";

/** How the limit is counted and what happens when it is reached. */
export interface RateLimitOptions {
  /** Hits allowed per window. */
  readonly limit: number;

  /** Length of the window in milliseconds. */
  readonly windowMs: number;

  /**
   * What is counted. Required, and deliberately so.
   *
   * There used to be a default — the address `ctx.server.requestIP`
   * reports — and it was the wrong kind of wrong. Behind a balancer that
   * address belongs to the balancer, so every client shares one bucket;
   * the limiter keeps working, says nothing, and nothing distinguishes it
   * from a limiter that is configured right until somebody hits a
   * stranger's limit. A guess about someone else's topology is not a safe
   * default, and this package makes the same trade `parseBody` does in
   * refusing to sniff a `content-type`: the caller knows, so the caller
   * says.
   *
   * It is also rarely an address that is meant. A session, an API token, a
   * tenant, an account — each is a better answer than "wherever this
   * packet came from" for the thing actually being protected.
   *
   * Returning `undefined` skips the limit for that request, which is how
   * an allowance is expressed — an internal caller, a health probe.
   *
   * It runs before the request is parsed, so it sees the request itself
   * and not the validated parts: `ctx.cookies` is not filled in yet, and a
   * cookie is read from Bun's `ctx.req.cookies`.
   *
   * @example
   * ```ts
   * rateLimit({
   *   limit: 5,
   *   windowMs: 60_000,
   *   key: (ctx) => ctx.req.cookies?.get("session") ?? undefined,
   * });
   * ```
   */
  readonly key: (ctx: BaseCtx) => string | undefined;

  /** Where counters live. In-process by default. */
  readonly store?: RateLimitStore;

  /** Status of a refusal. `429` by default. */
  readonly status?: number;

  /**
   * Whether every response carries `x-ratelimit-*`.
   *
   * On by default: a client that cannot see its budget can only discover
   * it by being refused.
   */
  readonly headers?: boolean;
}

/**
 * The hook of this package.
 *
 * Read off `rateLimit()` rather than written by hand: an annotation of
 * `AnyHook` would erase which slot the hook belongs to, and the stack
 * validation would reject it.
 */
export type RateLimitHook = ReturnType<typeof rateLimit>;

/**
 * Builds the rate-limiting hook.
 *
 * @example
 * ```ts
 * const perUser = rateLimit({
 *   limit: 100,
 *   windowMs: 60_000,
 *   key: (ctx) => ctx.req.headers.get("authorization") ?? undefined,
 * });
 * ```
 */
export function rateLimit(options: RateLimitOptions) {
  const store = options.store ?? memoryStore();
  const status = options.status ?? 429;
  const withHeaders = options.headers ?? true;

  const guard = hook.beforeParse(async (ctx) => {
    const key = options.key(ctx);

    if (key === undefined) {
      return undefined;
    }

    const window = await store.hit(key, options.windowMs);
    const remaining = Math.max(0, options.limit - window.count);
    const seconds = Math.max(
      0,
      Math.ceil((window.resetAt - Date.now()) / 1000),
    );

    if (withHeaders) {
      ctx.out.headers.set("x-ratelimit-limit", String(options.limit));
      ctx.out.headers.set("x-ratelimit-remaining", String(remaining));
      ctx.out.headers.set("x-ratelimit-reset", String(seconds));
    }

    if (window.count <= options.limit) {
      return undefined;
    }

    ctx.out.headers.set("retry-after", String(seconds));

    return Response.json(
      { ...errorBody(status, "RATE_LIMITED"), retryAfter: seconds },
      { status },
    );
  });

  return documented(guard, {
    responses: [
      {
        status,
        description: "Too many requests within the configured window",
        error: "RATE_LIMITED",
        fields: { retryAfter: { type: "integer", minimum: 0 } },
        headers: {
          "retry-after": {
            description: "Seconds until the window resets",
            schema: { type: "integer", minimum: 0 },
          },
        },
      },
    ],
  });
}
