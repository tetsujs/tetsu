/**
 * Rate limiting as a hook.
 *
 * ```ts
 * const limit = rateLimit({
 *   limit: 60,
 *   windowMs: 60_000,
 *   key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
 * });
 *
 * createApp({ hooks: { beforeParse: [limit] }, routes });
 * ```
 *
 * The refusal is a thrown `HttpError`, so it reaches the application's
 * `onError` hooks like every other failure, and an application with an
 * error format of its own formats this one too. It used to be a returned
 * `Response`, for speed: throwing costs 3.1–3.2× as much through the
 * pipeline (`bench/src/refusal.ts`). But the difference is about 800 ns,
 * spent after TLS, HTTP parsing and `Bun.serve` have had the request —
 * not what gives out first under a flood — and nearly all of it is the
 * error path itself, which any refusal that `onError` can see must take.
 *
 * The hook is annotated with what it answers, so a generated document says
 * `429` on every operation it guards without the routes repeating it.
 *
 * @module
 */

import type { BaseCtx, Hook } from "@tetsujs/core";
import { errorBody, HttpError, hook } from "@tetsujs/core";
import { documented } from "@tetsujs/openapi";
import type { RateLimitStore } from "./store.ts";
import { memoryStore } from "./store.ts";

export type { RateLimitStore, WindowState } from "./store.ts";
export { memoryStore } from "./store.ts";

/**
 * How the limit is counted and what happens when it is reached.
 *
 * `Ctx` is what `key` reads, inferred from how its parameter is typed.
 *
 * `store` and `name` come together or not at all: see {@link SharedCounters}.
 */
export type RateLimitOptions<Ctx extends BaseCtx = BaseCtx> =
  LimitOptions<Ctx> & (OwnCounters | SharedCounters);

/** The options of a limiter whatever its counters live in. */
interface LimitOptions<Ctx extends BaseCtx = BaseCtx> {
  /**
   * Hits allowed per window: an integer, `0` included — a limiter that
   * refuses everything.
   */
  readonly limit: number;

  /**
   * Length of the window in milliseconds: a positive, finite number.
   *
   * Anything else is refused when the limiter is made. `NaN` — what
   * `Number(process.env.RATE_WINDOW)` reads as when the variable is not
   * set — and `0` used to start a new window on every request, so nothing
   * was ever refused while the headers went on reporting a budget.
   */
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
   * It is also rarely an address that is meant. A user, a tenant, an
   * account — each is a better answer than "wherever this packet came
   * from" for the thing actually being protected, once a hook has
   * verified it.
   *
   * A key must be something the client cannot choose. A cookie, a token
   * or a header nobody has verified is whatever the client sends: a new
   * value is a new, empty budget. Count by the connection's address, or by
   * what a hook that verified the client put in the context.
   *
   * Returning `undefined` skips the limit for that request, which is how
   * an allowance is expressed — for an address on a list of your own, not
   * for a request that says it deserves one. `?? undefined` after a value
   * the client may leave out lets through everyone who leaves it out.
   *
   * It runs before the request is parsed, so it sees the request itself
   * and not the validated parts: `ctx.cookies` is not filled in yet, and a
   * cookie is read from Bun's `ctx.req.cookies`.
   *
   * What an earlier `beforeParse` hook returned is there too, once the
   * parameter says so with `Requires`: the limiter then demands it where
   * it is mounted, as any hook does, and a limiter mounted before the hook
   * that provides the field does not compile.
   *
   * @example
   * ```ts
   * rateLimit({
   *   limit: 5,
   *   windowMs: 60_000,
   *   key: (ctx) => ctx.server.requestIP(ctx.req)?.address,
   * });
   * ```
   *
   * @example A key another hook worked out
   * ```ts
   * const perClient = rateLimit({
   *   limit: 60,
   *   windowMs: 60_000,
   *   key: (ctx: Requires<{ clientIp: string }>) => ctx.clientIp,
   * });
   *
   * createApp({ hooks: { beforeParse: [clientIp, perClient] }, routes });
   * ```
   */
  readonly key: (ctx: Ctx) => string | undefined;

  /**
   * Whether each route has a budget of its own.
   *
   * Off by default: one limiter is one budget, across every route it is
   * mounted on — "100 a minute for the whole API". On, it is one budget
   * per route and client — "20 a minute on each endpoint" — from a single
   * limiter on the application or a group.
   *
   * A route is its template, `GET /orders/:id`, so every order shares
   * one. Requests no route answers — a `404`, a `405`, a CORS preflight —
   * share one budget between them, so probing paths that do not exist is
   * counted too; `cors()` before the limiter answers a preflight first.
   */
  readonly perRoute?: boolean;

  /**
   * The slot the limiter runs in: `"beforeParse"`, the default,
   * `"beforeValidation"` or `"beforeHandle"`.
   *
   * Before the body is read, a refusal costs nothing, and the key reads
   * the request and what earlier hooks returned — an address, a user a
   * hook verified. Some limits need more: the one that stops guessing a
   * password across many addresses counts by the account the body names,
   * and that is there once the body is validated. `"beforeHandle"` gives
   * the key the validated parts and what `beforeHandle` hooks before it
   * returned:
   *
   * ```ts
   * const perAccount = rateLimit({
   *   slot: "beforeHandle",
   *   limit: 5,
   *   windowMs: 15 * 60_000,
   *   key: (ctx: Requires<{ body: { email: string } }>) => ctx.body.email,
   * });
   *
   * route({ method: "POST", path: "/login", schema: { body: Login }, hooks: { beforeHandle: [perAccount] }, handler });
   * ```
   *
   * The limiter goes in the slot it was made for, and nowhere else: the
   * compiler refuses one mounted in another. A slot after the handler is
   * not one of these — by then there is nothing left to protect.
   */
  readonly slot?: LimitSlot;

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

/** Counters in the limiter itself: one limiter, one budget. */
export interface OwnCounters {
  readonly store?: undefined;
  readonly name?: undefined;
}

/**
 * Counters in a store the limiter is given — a Redis every server of a
 * fleet shares.
 *
 * A store finds a counter by its key alone, and the limiter's name is
 * what tells its counters from another's: the key is the name, then the
 * client, as in `shop-login:203.0.113.7`. Without one, two limiters on one
 * store counted into one counter — a login allowed five an hour lived in
 * the window of a global limit allowed a hundred a minute.
 *
 * In a store, the name is the budget. Every server of a fleet whose
 * limiter has the name shares it, which is what a shared store is for;
 * two services on one Redis need two names. One name on one store with
 * other settings is refused when the second limiter is made: one counter
 * cannot have two windows.
 */
export interface SharedCounters {
  /** Where the counters live. */
  readonly store: RateLimitStore;

  /** What tells this limiter's counters from any other's in the store. */
  readonly name: string;
}

/**
 * The hook of this package.
 *
 * A limiter in `beforeParse` whose key reads the request alone. Not
 * `AnyHook`, which would erase the slot and have the stack validation
 * reject it. A limiter whose key demands more, or one made for another
 * `slot`, is typed by `ReturnType` of its own `rateLimit()` call.
 */
export type RateLimitHook = Hook<"beforeParse", BaseCtx, unknown>;

/** The slots a limiter may run in: those before the handler. */
export type LimitSlot = "beforeParse" | "beforeValidation" | "beforeHandle";

/**
 * Builds the rate-limiting hook.
 *
 * @example
 * ```ts
 * const perUser = rateLimit({
 *   limit: 100,
 *   windowMs: 60_000,
 *   key: (ctx: Requires<{ userId: string }>) => ctx.userId,
 * });
 * ```
 */
export function rateLimit<Ctx extends BaseCtx = BaseCtx>(
  options: RateLimitOptions<Ctx> & { readonly slot?: "beforeParse" },
): Hook<"beforeParse", Ctx, unknown>;
export function rateLimit<Ctx extends BaseCtx = BaseCtx>(
  options: RateLimitOptions<Ctx> & { readonly slot: "beforeValidation" },
): Hook<"beforeValidation", Ctx, unknown>;
export function rateLimit<Ctx extends BaseCtx = BaseCtx>(
  options: RateLimitOptions<Ctx> & { readonly slot: "beforeHandle" },
): Hook<"beforeHandle", Ctx, unknown>;
export function rateLimit<Ctx extends BaseCtx = BaseCtx>(
  options: RateLimitOptions<Ctx>,
): Hook<LimitSlot, Ctx, unknown> {
  assertOptions(options);

  const store = options.store ?? memoryStore();
  const status = options.status ?? 429;
  const withHeaders = options.headers ?? true;
  const prefix = options.name === undefined ? "" : `${options.name}:`;

  // One body for every slot: the factories differ only in the context
  // they promise, and the key's own parameter says what it reads.
  const factory = hook[options.slot ?? "beforeParse"] as unknown as (
    fn: (ctx: Ctx) => Promise<undefined>,
  ) => Hook<LimitSlot, Ctx, unknown>;

  const guard = factory(async (ctx: Ctx) => {
    const client = options.key(ctx);

    if (client === undefined) {
      return undefined;
    }

    const route = options.perRoute ? `${routeOf(ctx)}:` : "";
    const window = await store.hit(
      `${prefix}${route}${client}`,
      options.windowMs,
    );
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

    // A store may answer with a window already over — a Redis key whose
    // expiry was never set. "Come back in 0 seconds" is then an invitation
    // to try again at once, as fast as the client can.
    const retryAfter = Math.max(1, seconds);

    ctx.out.headers.set("retry-after", String(retryAfter));

    throw new HttpError(status, {
      ...errorBody(status, "RATE_LIMITED"),
      retryAfter,
    });
  });

  return documented(guard, {
    responses: [
      {
        status,
        description: "Too many requests within the configured window",
        error: "RATE_LIMITED",
        fields: { retryAfter: { type: "integer", minimum: 1 } },
        headers: {
          "retry-after": {
            description: "Seconds until the window resets",
            schema: { type: "integer", minimum: 1 },
          },
        },
      },
    ],
  });
}

/**
 * Which settings each name on each store was given — so a second limiter
 * under a name can be told apart from another copy of the first.
 *
 * Another copy is ordinary: an application rebuilt for every test makes
 * its limiters again, and every server of a fleet has one. Other settings
 * under the same name are not: the counter is one, and would be counted
 * against two limits and reset by two windows.
 */
const claimed = new WeakMap<RateLimitStore, Map<string, string>>();

const limitSlots: ReadonlySet<string> = new Set<LimitSlot>([
  "beforeParse",
  "beforeValidation",
  "beforeHandle",
]);

/**
 * Refuses a limiter that would not limit, or would count into another's
 * counters. Typed loosely on purpose: it is what holds for a caller the
 * types did not reach — plain JavaScript, a value cast on its way in.
 */
function assertOptions(
  options: LimitOptions<never> & {
    store?: RateLimitStore | undefined;
    name?: unknown;
  },
): void {
  if (!(Number.isFinite(options.windowMs) && options.windowMs > 0)) {
    throw new Error(
      `rateLimit: windowMs must be a positive number of milliseconds, got ${options.windowMs} — Number() of a variable that is not set is NaN, and a window of NaN or 0 refuses nothing`,
    );
  }

  if (options.slot !== undefined && !limitSlots.has(options.slot)) {
    throw new Error(
      `rateLimit: slot must be beforeParse, beforeValidation or beforeHandle, got ${String(options.slot)} — after the handler there is nothing left to protect`,
    );
  }

  if (!(Number.isInteger(options.limit) && options.limit >= 0)) {
    throw new Error(
      `rateLimit: limit must be a whole number of requests, 0 or more, got ${options.limit}`,
    );
  }

  if (options.store == null) {
    if (options.name !== undefined) {
      throw new Error(
        `rateLimit: name "${String(options.name)}" is given without a store — a name tells counters apart in a shared store, and without one the counters are the limiter's own`,
      );
    }

    return;
  }

  if (typeof options.name !== "string" || options.name === "") {
    throw new Error(
      "rateLimit: a limiter given a store needs a name — the store finds counters by key, and the name keeps this limiter's apart from every other's in it",
    );
  }

  const settings = `limit ${options.limit}, windowMs ${options.windowMs}, perRoute ${options.perRoute === true}, slot ${options.slot ?? "beforeParse"}`;
  const names = claimed.get(options.store) ?? new Map<string, string>();
  const earlier = names.get(options.name);

  if (earlier !== undefined && earlier !== settings) {
    throw new Error(
      `rateLimit: "${options.name}" is already a limiter on this store with ${earlier}, and this one has ${settings} — one name is one counter, and cannot have two limits; give this limiter a name of its own`,
    );
  }

  names.set(options.name, settings);
  claimed.set(options.store, names);
}

/**
 * The route a request is counted under with `perRoute`: its method and
 * template, or one name for every request no route answers.
 */
function routeOf(ctx: BaseCtx): string {
  return ctx.route ? `${ctx.route.method}:${ctx.route.path}` : "unrouted";
}
