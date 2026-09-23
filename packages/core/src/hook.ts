/**
 * Lifecycle hooks — the framework's middleware model.
 *
 * A hook is a plain function bound to one slot of the request lifecycle:
 *
 * ```
 * beforeParse → parse → beforeValidation → validate → beforeHandle
 *   → handler → beforeResponse → (send) → afterResponse | onError
 * ```
 *
 * There is no onion and no `next()`: every hook has an explicit position in
 * time, errors are handled by the `onError` slot, and "after" logic lives in
 * `beforeResponse` / `afterResponse`.
 *
 * Hooks are branded objects produced by the `hook.*` factories. A bare
 * function is not accepted in route hook tuples — wrapping is what makes
 * context extensions flow into handler types.
 *
 * @module
 */

import type { BaseCtx } from "./context.ts";

/**
 * All lifecycle slots a hook can be bound to.
 */
export type SlotName =
  | "beforeParse"
  | "beforeValidation"
  | "beforeHandle"
  | "beforeResponse"
  | "afterResponse"
  | "onError";

/**
 * All slot names in lifecycle order — the canonical runtime list used by
 * the route table and the pipeline. Internal to the core.
 */
export const slotNames = [
  "beforeParse",
  "beforeValidation",
  "beforeHandle",
  "beforeResponse",
  "afterResponse",
  "onError",
] as const satisfies readonly SlotName[];

declare const hookBrand: unique symbol;

type HookFn = (ctx: never) => unknown;

/**
 * A function bound to a lifecycle slot, carrying its typing as phantom data.
 *
 * `Req` is the context the hook requires (its declared `ctx` parameter) and
 * `Ext` is the extension it contributes by returning an object. Both exist
 * only at the type level; at runtime a hook is `{ slot, fn }`.
 *
 * @typeParam Slot - The lifecycle slot this hook runs in.
 * @typeParam Req - The context shape this hook requires.
 * @typeParam Ext - The context extension this hook contributes.
 */
export interface Hook<Slot extends SlotName, Req, Ext> {
  readonly slot: Slot;
  readonly fn: HookFn;
  readonly [hookBrand]: { readonly req: Req; readonly ext: Ext };
}

/**
 * The widest hook type; phantom positions are covariant, so every concrete
 * hook is assignable without `any`.
 */
export type AnyHook = Hook<SlotName, unknown, unknown>;

/**
 * Extracts the lifecycle slot of a hook. Internal to the core.
 */
export type SlotOf<H> = H extends Hook<infer S, unknown, unknown> ? S : never;

/**
 * Extracts the required context of a hook. Internal to the core.
 */
export type ReqOf<H> = H extends Hook<SlotName, infer R, unknown> ? R : never;

/**
 * Extracts the context extension of a hook. Internal to the core.
 */
export type ExtOf<H> = H extends Hook<SlotName, unknown, infer E> ? E : never;

// biome-ignore lint/suspicious/noConfusingVoidType: void is a legal return of an observing hook and must be excludable
type Skipped = void | undefined | null;

type NonExt = Response | Skipped;

/**
 * Context keys a hook's return value can never contribute — the type-level
 * mirror of the pipeline's `protectedKeys` (guard.ts). The runtime
 * silently drops these keys from every extension, so typing them as
 * contributed would make the context lie: a hook "returning" `{ server }`
 * would give downstream code a forged type while the real server keeps
 * flowing at runtime. Kept in sync with `protectedKeys` by hand; change
 * both in the same commit.
 */
type PipelineOwnedKey =
  | "__proto__"
  | "constructor"
  | "prototype"
  | "req"
  | "server"
  | "out"
  | "route"
  | "res"
  | "error";

/**
 * The keys of a hook's return value that actually reach the context.
 *
 * `extendContext` iterates `Object.keys`, so only own enumerable **string**
 * keys are ever copied: a symbol key never arrives, and typing it as
 * contributed would promise a field the runtime does not create.
 * Pipeline-owned names are dropped on top of that, by the runtime guard.
 */
type ContributedKey<T> = Exclude<Extract<keyof T, string>, PipelineOwnedKey>;

type StripOwned<T> = T extends unknown ? Pick<T, ContributedKey<T>> : never;

/**
 * The context extension a hook's return type contributes.
 *
 * A hook that may return nothing contributes an **optional** extension: the
 * runtime skips the merge, so typing the fields as always present would be
 * a lie — `return user ? { user } : undefined` must not make `ctx.user`
 * non-nullable. Returning a `Response` short-circuits instead of skipping,
 * so it does not weaken the extension. Only the keys the runtime copies
 * survive here — see `ContributedKey`.
 */
type CleanExt<R> = [Exclude<Awaited<R>, NonExt>] extends [never]
  ? unknown
  : [Extract<Awaited<R>, Skipped>] extends [never]
    ? StripOwned<Exclude<Awaited<R>, NonExt>>
    : Partial<StripOwned<Exclude<Awaited<R>, NonExt>>>;

// biome-ignore lint/suspicious/noConfusingVoidType: hooks that only observe legitimately return nothing
type HookReturn = object | Response | void | undefined;

interface HookFactory<Slot extends SlotName, SlotBase extends BaseCtx> {
  <R extends HookReturn | Promise<HookReturn> = void>(
    fn: (ctx: SlotBase) => R,
  ): Hook<Slot, SlotBase, CleanExt<R>>;

  <C extends BaseCtx, R extends HookReturn | Promise<HookReturn> = void>(
    fn: (ctx: C) => R,
  ): Hook<Slot, C, CleanExt<R>>;
}

type RawParams = Record<string, string>;

/**
 * The context each slot guarantees on its own, before any schema or hook
 * contributes to it — the parameter type of an unannotated hook, and the
 * most a group-level hook may require.
 */
export interface SlotBases {
  readonly beforeParse: BaseCtx & { readonly params: RawParams };
  readonly beforeValidation: BaseCtx & {
    readonly params: RawParams;
    readonly body: unknown;
  };
  readonly beforeHandle: BaseCtx;
  readonly beforeResponse: BaseCtx & { readonly res: Response };
  readonly afterResponse: BaseCtx & { readonly res: Response };
  readonly onError: BaseCtx & { readonly error: unknown };
}

interface HookFactories {
  /**
   * Runs before body parsing and validation.
   *
   * The place for auth, rate limiting and caching: a `401` from here is
   * guaranteed to precede a `422`, and a rejected request never pays for
   * body parsing. Returning a `Response` short-circuits the request.
   */
  readonly beforeParse: HookFactory<"beforeParse", SlotBases["beforeParse"]>;

  /**
   * Runs after the body is parsed but before schemas validate it.
   *
   * The place to normalize raw input: trim strings, map legacy field names.
   * `ctx.body` is `unknown` here — parsed, not yet trusted.
   */
  readonly beforeValidation: HookFactory<
    "beforeValidation",
    SlotBases["beforeValidation"]
  >;

  /**
   * Runs after validation, right before the handler.
   *
   * The place for logic that needs trusted data: loading entities by
   * validated params, ownership checks, opening transactions. Declare the
   * required context with the `Requires` contract.
   */
  readonly beforeHandle: HookFactory<"beforeHandle", BaseCtx>;

  /**
   * Runs after the handler produced a response.
   *
   * May replace the response by returning a new `Response` — cache headers,
   * response mapping.
   */
  readonly beforeResponse: HookFactory<
    "beforeResponse",
    SlotBases["beforeResponse"]
  >;

  /**
   * Runs after the response is handed to the runtime; executes always,
   * including after errors.
   *
   * Observation only — metrics, access logs, audit. The return value cannot
   * affect the response.
   */
  readonly afterResponse: HookFactory<
    "afterResponse",
    SlotBases["afterResponse"]
  >;

  /**
   * Runs when any lifecycle stage throws.
   *
   * May map the error to a `Response`; otherwise the error continues to the
   * next `onError` scope (route → group → app) and finally to the default
   * error mapper.
   */
  readonly onError: HookFactory<"onError", SlotBases["onError"]>;
}

function factory<Slot extends SlotName, SlotBase extends BaseCtx>(
  slot: Slot,
): HookFactory<Slot, SlotBase> {
  const create = (fn: HookFn) => ({ slot, fn });

  return create as unknown as HookFactory<Slot, SlotBase>;
}

/**
 * Factories creating lifecycle hooks, one per slot.
 *
 * A hook extends the context by returning an object: the returned fields are
 * merged into `ctx` and their types flow to everything downstream, including
 * the handler. Returning a `Response` short-circuits the request; returning
 * nothing leaves the context untouched.
 *
 * Build that `Response` on every call. Its body is a single-use stream, so
 * a module-level constant serves its body to the first request and an empty
 * one to every request after — with the status and headers still intact,
 * which makes the bug quiet.
 *
 * **Return a plain object literal.** The merge copies own enumerable string
 * keys and nothing else, so a class instance contributes its own fields
 * while its methods and getters — prototype members — never arrive, and an
 * array contributes its indices rather than `length`. The types follow the
 * runtime where they can (symbol keys and pipeline-owned names are stripped
 * from the extension), but a class instance and an object literal are the
 * same type to the compiler: for prototype members this is a contract, not
 * a check.
 *
 * @example An extending hook — adds typed `ctx.user`
 * ```ts
 * export const auth = hook.beforeParse(async (ctx) => {
 *   const user = await verifyToken(ctx.req.headers.get("authorization"));
 *   if (!user) throw new HttpError(401);
 *   return { user };
 * });
 * ```
 *
 * @example An observing hook — sees the response, changes nothing
 * ```ts
 * export const accessLog = hook.afterResponse((ctx) => {
 *   console.log(ctx.req.method, ctx.req.url, ctx.res.status);
 * });
 * ```
 */
export const hook: HookFactories = {
  beforeParse: factory<"beforeParse", SlotBases["beforeParse"]>("beforeParse"),
  beforeValidation: factory<"beforeValidation", SlotBases["beforeValidation"]>(
    "beforeValidation",
  ),
  beforeHandle: factory<"beforeHandle", SlotBases["beforeHandle"]>(
    "beforeHandle",
  ),
  beforeResponse: factory<"beforeResponse", SlotBases["beforeResponse"]>(
    "beforeResponse",
  ),
  afterResponse: factory<"afterResponse", SlotBases["afterResponse"]>(
    "afterResponse",
  ),
  onError: factory<"onError", SlotBases["onError"]>("onError"),
};

/**
 * Builds a reusable, ordered tuple of hooks without `as const`.
 *
 * @example
 * ```ts
 * const secured = stack(auth, rateLimit);
 *
 * route({
 *   method: "GET",
 *   path: "/orders",
 *   hooks: { beforeParse: secured },
 *   handler: (ctx) => orders.listFor(ctx.user.id),
 * });
 * ```
 */
export function stack<const T extends readonly AnyHook[]>(...hooks: T): T {
  return hooks;
}
