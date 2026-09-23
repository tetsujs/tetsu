/**
 * Compile-time validation of route hook stacks.
 *
 * The machinery room of the core: recursive tuple types check every hook
 * against the slot it is placed in and against the context accumulated by
 * the path, the schemas and the preceding hooks. Invalid stacks surface as
 * branded error types whose messages read as plain sentences in compiler
 * output.
 *
 * Nothing in this module executes. `route()` applies these types at its
 * call site; no other module needs to look inside.
 *
 * @module
 */

import type {
  BaseCtx,
  EarlyCtx,
  ParsedBody,
  SchemaConfig,
  ValidatedCtx,
} from "./context.ts";
import type { AnyHook, Hook, SlotBases, SlotName, SlotOf } from "./hook.ts";
import type { Prettify } from "./internal.ts";
import type { ExtractParams } from "./path.ts";
import type { AnySchema, InferOutput } from "./schema.ts";

declare const typeErrorBrand: unique symbol;

/**
 * Compile-time error: a hook's required context is not satisfied.
 *
 * Appears in compiler output when a hook is placed into a stack that does
 * not provide what the hook's `Requires` contract demands — the message
 * names the missing context keys.
 */
export interface HookRequirementError<Msg extends string> {
  readonly [typeErrorBrand]: Msg;
}

/**
 * Compile-time error: a hook is placed into a slot it does not belong to.
 */
export interface HookSlotError<Msg extends string> {
  readonly [typeErrorBrand]: Msg;
}

/**
 * Compile-time error: a hook stack arrived as an array type rather than a
 * tuple, and nothing about it can be checked.
 *
 * `const reused = [auth]` is `Hook[]`, not `readonly [typeof auth]`: the
 * element types are gone, so requirements, slots and context extensions
 * are all unknowable. Silently accepting such a stack would turn the
 * central compile-time guarantee off exactly where hooks are shared
 * between routes.
 */
export interface HookStackError<Msg extends string> {
  readonly [typeErrorBrand]: Msg;
}

type MissingKeys<Req, Ctx> = {
  [K in keyof Req]: K extends keyof Ctx
    ? Ctx[K & keyof Ctx] extends Req[K]
      ? never
      : K
    : K;
}[keyof Req] &
  string;

/**
 * A function that was not wrapped by a `hook.*` factory.
 *
 * Accepted by the *input* shape of a hooks config (`HooksInput`) so that
 * tuple validation can brand it with a readable error at its exact
 * position. Rejecting it at the constraint instead produces the
 * compiler's default tuple mismatch — "not assignable to type 'never'" —
 * which names neither the problem nor the fix, on the single most common
 * beginner mistake. Internal to the core.
 */
export type BareFunction = (ctx: never) => unknown;

type SlotInput = readonly (AnyHook | BareFunction)[];

/**
 * The widest hooks config accepted at a call site, before validation:
 * every slot may also hold bare functions, which `ValidateStack` and its
 * siblings replace with a branded "wrap it with hook.*" error. Valid
 * programs only ever store `HooksConfig`. Internal to the core.
 */
export interface HooksInput {
  readonly beforeParse?: SlotInput;
  readonly beforeValidation?: SlotInput;
  readonly beforeHandle?: SlotInput;
  readonly beforeResponse?: SlotInput;
  readonly afterResponse?: SlotInput;
  readonly onError?: SlotInput;
}

/**
 * Validates one slot's hook tuple against the context available in that
 * slot.
 *
 * Walks the tuple left to right, accumulating each hook's extension into
 * the context for the hooks that follow — order inside a slot is execution
 * order. Elements that fail are replaced with a branded error type, which
 * makes the assignment fail with the error's message at the exact position
 * of the offending hook.
 *
 * Internal to the core: applied by `route()` through `ValidateHooks`.
 */
export type ValidateStack<
  Hooks,
  Slot extends SlotName,
  Ctx,
> = Hooks extends readonly [infer H, ...infer Rest]
  ? H extends Hook<Slot, infer Req, infer Ext>
    ? [Ctx] extends [Req]
      ? readonly [H, ...ValidateStack<Rest, Slot, Merge<Ctx, Ext>>]
      : readonly [
          HookRequirementError<`Hook requires context '${MissingKeys<Req, Ctx>}' which is not provided by path, schema or preceding hooks`>,
          ...ValidateStack<Rest, Slot, Merge<Ctx, Ext>>,
        ]
    : H extends AnyHook
      ? readonly [
          HookSlotError<`Hook of slot '${SlotOf<H> & string}' cannot be placed into '${Slot}'`>,
          ...ValidateStack<Rest, Slot, Ctx>,
        ]
      : readonly [
          HookSlotError<`A bare function is not a hook — wrap it with hook.${Slot}(...)`>,
          ...ValidateStack<Rest, Slot, Ctx>,
        ]
  : Hooks extends readonly []
    ? Hooks
    : readonly HookStackError<"A widened hook array loses its element types and cannot be checked — build the stack with stack(...) or inline the tuple">[];

/**
 * Validates one slot's hook tuple against a fixed context that does not
 * accumulate.
 *
 * For the response slots and `onError`: the runtime never merges their
 * return values into the context — `finalize` treats a returned `Response`
 * as a replacement and ignores everything else — so a hook in these slots
 * must not be typed as seeing the "extension" of the hook before it.
 * `ValidateStack` would thread `Merge` through and promise context the
 * pipeline never produces.
 *
 * Internal to the core: applied by `route()` through `ValidateHooks`.
 */
export type ValidateStaticStack<
  Hooks,
  Slot extends SlotName,
  Ctx,
> = Hooks extends readonly [infer H, ...infer Rest]
  ? H extends Hook<Slot, infer Req, unknown>
    ? [Ctx] extends [Req]
      ? readonly [H, ...ValidateStaticStack<Rest, Slot, Ctx>]
      : readonly [
          HookRequirementError<`Hook requires context '${MissingKeys<Req, Ctx>}' which is not provided by path, schema or preceding hooks`>,
          ...ValidateStaticStack<Rest, Slot, Ctx>,
        ]
    : H extends AnyHook
      ? readonly [
          HookSlotError<`Hook of slot '${SlotOf<H> & string}' cannot be placed into '${Slot}'`>,
          ...ValidateStaticStack<Rest, Slot, Ctx>,
        ]
      : readonly [
          HookSlotError<`A bare function is not a hook — wrap it with hook.${Slot}(...)`>,
          ...ValidateStaticStack<Rest, Slot, Ctx>,
        ]
  : Hooks extends readonly []
    ? Hooks
    : readonly HookStackError<"A widened hook array loses its element types and cannot be checked — build the stack with stack(...) or inline the tuple">[];

/**
 * Validates one slot's hook tuple for a group or the application.
 *
 * Unlike `ValidateStack`, there is no accumulated context to check against:
 * a group does not know which routes it will contain, so a hook it carries
 * may require no more than what the slot itself guarantees (`SlotBases`).
 *
 * The check must be this explicit conditional. `Req` sits in a covariant
 * phantom position, so plain assignability to `Hook<Slot, SlotBases[Slot],
 * unknown>` tests the opposite direction — it rejects hooks requiring
 * *less* than the slot base and admits hooks requiring *more*, which is
 * exactly the hook a group cannot satisfy.
 *
 * Internal to the core: applied by `group()` and `createApp()` through
 * `ValidateGroupHooks`.
 */
export type ValidateGroupStack<
  Hooks,
  Slot extends SlotName,
> = Hooks extends readonly [infer H, ...infer Rest]
  ? H extends Hook<Slot, infer Req, unknown>
    ? [SlotBases[Slot]] extends [Req]
      ? readonly [H, ...ValidateGroupStack<Rest, Slot>]
      : readonly [
          HookRequirementError<`Hook requires context '${MissingKeys<Req, SlotBases[Slot]>}' which a group cannot provide — typed context comes from a route's own schemas and hooks`>,
          ...ValidateGroupStack<Rest, Slot>,
        ]
    : H extends AnyHook
      ? readonly [
          HookSlotError<`Hook of slot '${SlotOf<H> & string}' cannot be placed into '${Slot}'`>,
          ...ValidateGroupStack<Rest, Slot>,
        ]
      : readonly [
          HookSlotError<`A bare function is not a hook — wrap it with hook.${Slot}(...)`>,
          ...ValidateGroupStack<Rest, Slot>,
        ]
  : Hooks extends readonly []
    ? Hooks
    : readonly HookStackError<"A widened hook array loses its element types and cannot be checked — build the stack with stack(...) or inline the tuple">[];

/**
 * Validates a full group-level (or application-level) hooks config: every
 * slot's tuple is checked against what that slot alone guarantees.
 *
 * Internal to the core: `group()` and `createApp()` intersect their
 * `hooks` property with this type.
 */
export type ValidateGroupHooks<H> = {
  readonly [K in SlotName]?: ValidateGroupStack<StackOf<H, K>, K>;
};

/**
 * What `group()` and `createApp()` accept as `hooks`: one set, or a list
 * of sets.
 *
 * A hook package returns a set, and a list is how it is mounted whole.
 * Spreading it slot by slot into one set was the only way before, and a
 * slot left out went unnoticed — CORS that answers the preflight and then
 * forgets the header on the response it was for. Internal to the core.
 */
export type GroupHooksInput = HooksInput | readonly HooksInput[];

/**
 * Validates `hooks` as `group()` and `createApp()` take it: a lone set as
 * {@link ValidateGroupHooks} does, a list set by set.
 *
 * The sets need no checking against each other: a group hook may require
 * only what its slot guarantees, never what another hook contributed, so
 * the order of a list decides the order of execution and nothing else.
 * Internal to the core.
 */
export type ValidateGroupHooksInput<H> = H extends readonly unknown[]
  ? { readonly [I in keyof H]: ValidateGroupHooks<H[I]> }
  : ValidateGroupHooks<H>;

/**
 * Reads one slot's tuple out of a hooks config, defaulting to an empty
 * tuple when the slot is absent. Internal to the core.
 */
export type StackOf<H, K extends SlotName> = K extends keyof H
  ? H[K] extends SlotInput
    ? H[K]
    : Exclude<H[K], undefined>
  : readonly [];

/**
 * Merges a context extension into a context, letting the extension win.
 *
 * Mirrors the runtime, where a later hook's field overwrites an earlier
 * one's: an intersection would instead claim both types hold at once, and
 * a hook normalizing `body` would end up typed as the old body *and* the
 * new one.
 *
 * A key the extension only **may** contribute — the hook can skip — is
 * optional here, and it replaces an earlier key of the same name rather
 * than joining it: `contributed | undefined`, not `earlier | contributed`.
 * That is less precise than the runtime when the hook skips and an earlier
 * value survives. The precise form was measured and given up: telling
 * optional keys from required ones at every level of these nested merges
 * made the compiler build about a hundred times the types — 477 000 for a
 * single route with one hook, 1.6 GB and 8 s for two hundred routes —
 * which is an application the editor cannot hold. What it bought is
 * narrow: the parts a schema owns are re-asserted after the hooks anyway
 * (`SchemaOwned`), so the loss is confined to two hooks writing the same
 * field of their own, the later one conditionally. `bench/src/types.ts`
 * guards the cost.
 *
 * An extension typed with an index signature falls back to an
 * intersection — its key set is unknown, so removing "its" keys would
 * erase the whole context. Internal to the core.
 */
export type Merge<Ctx, Ext> = [keyof Ext] extends [never]
  ? Ctx
  : string extends keyof Ext
    ? Ctx & Ext
    : Omit<Ctx, keyof Ext> & Ext;

/**
 * The context extensions contributed by a hook tuple, in tuple order —
 * later contributions overwrite earlier ones, as they do at runtime.
 * Internal to the core.
 */
export type ExtOfStack<Hooks> = Hooks extends readonly [infer H, ...infer Rest]
  ? Merge<
      H extends Hook<SlotName, unknown, infer E> ? E : never,
      ExtOfStack<Rest>
    >
  : unknown;

/**
 * Hooks of a route, a group or the app, keyed by lifecycle slot.
 *
 * Tuples accept only branded hooks produced by the `hook.*` factories.
 * Order inside a tuple is execution order; the slots themselves run in
 * lifecycle order regardless of their position in this object.
 */
export interface HooksConfig {
  readonly beforeParse?: readonly AnyHook[];
  readonly beforeValidation?: readonly AnyHook[];
  readonly beforeHandle?: readonly AnyHook[];
  readonly beforeResponse?: readonly AnyHook[];
  readonly afterResponse?: readonly AnyHook[];
  readonly onError?: readonly AnyHook[];
}

/**
 * The request parts a route's schemas own once validation has run.
 *
 * `parseBody` and `validate()` execute after the pre-validation hooks and
 * overwrite exactly these fields, so in the type they have to sit *on top*
 * of what `beforeParse` and `beforeValidation` contributed — the reverse of
 * the "later contribution wins" order that holds everywhere else. A hook
 * may still normalize a declared part; what the code downstream sees is
 * the validator's output. Parts without a schema are absent here, and a
 * hook's contribution to them survives, exactly as it does at runtime.
 * Internal to the core.
 */
type SchemaOwned<S extends SchemaConfig> = (S["params"] extends infer P extends
  AnySchema
  ? { readonly params: InferOutput<P> }
  : unknown) &
  (S["query"] extends infer Q extends AnySchema
    ? { readonly query: InferOutput<Q> }
    : unknown) &
  (S["body"] extends infer B extends AnySchema
    ? { readonly body: InferOutput<B> }
    : unknown) &
  (S["headers"] extends infer H extends AnySchema
    ? { readonly headers: InferOutput<H> }
    : unknown) &
  (S["cookies"] extends infer C extends AnySchema
    ? { readonly cookies: InferOutput<C> }
    : unknown);

/**
 * The context of the `beforeHandle` slot: everything the path, the schemas
 * and the two pre-validation slots have produced by the time validation is
 * done. Also the base the handler context is built on. Internal to the
 * core.
 */
type BeforeHandleCtx<Path extends string, S extends SchemaConfig, H, B> = Merge<
  Merge<
    Merge<ValidatedCtx<Path, S, B>, ExtOfStack<StackOf<H, "beforeParse">>>,
    ExtOfStack<StackOf<H, "beforeValidation">>
  >,
  SchemaOwned<S>
>;

/**
 * The context type a route handler receives: the validated context of the
 * path and schemas, extended by every contribution of the route's
 * `beforeParse`, `beforeValidation` and `beforeHandle` hooks.
 *
 * A contribution to a part the schema declares does not show through:
 * validation overwrites those fields after the pre-validation hooks ran
 * (see `SchemaOwned`). A `beforeHandle` contribution does win — that slot
 * runs after validation, in the type as at runtime.
 *
 * With a response map, `out` is a `DeclaredOutgoing` (see `ValidatedCtx`):
 * the handler can write only a status the map declares. Hooks keep the
 * plain `Outgoing` — they do not know which route they run for.
 *
 * @example
 * ```ts
 * type Ctx = HandlerCtx<
 *   "/orders/:id",
 *   { body: typeof CreateOrder },
 *   { beforeParse: [typeof auth] }
 * >;
 * //   ^? { req; server; out; params: { id: string }; body: ...; user: ... }
 * ```
 */
export type HandlerCtx<
  Path extends string,
  S extends SchemaConfig,
  H,
  B = undefined,
> = Prettify<
  Merge<BeforeHandleCtx<Path, S, H, B>, ExtOfStack<StackOf<H, "beforeHandle">>>
>;

/**
 * The `params` shape a response-slot (or error) hook can rely on.
 *
 * With a `params` schema the honest type is a union: an error may arrive
 * before validation ran (raw path strings) or after (the schema's output),
 * and a hook cannot know which. Without a schema the raw strings are the
 * only shape that ever exists. Internal to the core.
 */
type ResponseParams<
  Path extends string,
  S extends SchemaConfig,
> = S["params"] extends infer P extends AnySchema
  ? ExtractParams<Path> | InferOutput<P>
  : ExtractParams<Path>;

/**
 * The context a response-slot hook receives.
 *
 * These slots run on every outcome, including short-circuits and errors
 * raised before the handler — so the schema-validated fields and the hook
 * extensions may never have been produced. They are therefore optional
 * here, and a hook that needs one has to narrow. The early context and the
 * response itself are guaranteed; `params` is guaranteed but honest about
 * timing — see `ResponseParams`.
 *
 * Built with `Merge`, not an intersection: intersecting the raw and the
 * validated `params` shapes would collapse conflicting fields to `never`,
 * silently satisfying every requirement check.
 *
 * Not flattened with `Prettify`, unlike `HandlerCtx`: nobody reads it on
 * hover — a hook declares the context it wants and this is only what that
 * declaration is checked against — and flattening it was a tenth of what
 * a route with a response hook cost the compiler (`bench/src/types.ts`).
 */
export type ResponseCtx<
  Path extends string,
  S extends SchemaConfig,
  H,
  B = undefined,
> = Merge<
  Partial<HandlerCtx<Path, S, H, B>>,
  BaseCtx & {
    readonly params: ResponseParams<Path, S>;
    readonly res: Response;
  }
>;

/**
 * The context an `onError` hook receives.
 *
 * Shaped like `ResponseCtx` — an error may arrive before or after any
 * given stage ran, so the validated fields and hook extensions are
 * optional and `params` is the honest union (`ResponseParams`) — except
 * that `error` is guaranteed and a response is not: the error mapping is
 * what produces one.
 */
export type ErrorCtx<
  Path extends string,
  S extends SchemaConfig,
  H,
  B = undefined,
> = Merge<
  Partial<HandlerCtx<Path, S, H, B>>,
  BaseCtx & {
    readonly params: ResponseParams<Path, S>;
    readonly error: unknown;
  }
>;

/**
 * Validates a full hooks config: every slot's tuple is checked against the
 * context that actually exists when that slot runs.
 *
 * `beforeParse` sees the early context; `beforeValidation` additionally
 * sees the raw body; `beforeHandle` sees the validated context; the
 * response slots see the handler context plus `res`; `onError` sees the
 * handler context (optional, an error may precede it) plus `error`.
 *
 * The pre-handler slots accumulate extensions hook by hook
 * (`ValidateStack`); the response slots and `onError` do not — the runtime
 * ignores their non-`Response` returns (`ValidateStaticStack`).
 *
 * Internal to the core: `route()` intersects its `hooks` property with
 * this type.
 */
export type ValidateHooks<
  H,
  Path extends string,
  S extends SchemaConfig,
  B = undefined,
> = {
  readonly beforeParse?: ValidateStack<
    StackOf<H, "beforeParse">,
    "beforeParse",
    EarlyCtx<Path>
  >;
  readonly beforeValidation?: ValidateStack<
    StackOf<H, "beforeValidation">,
    "beforeValidation",
    Merge<
      Merge<
        EarlyCtx<Path> & { readonly body: ParsedBody<B> },
        ExtOfStack<StackOf<H, "beforeParse">>
      >,
      S["body"] extends AnySchema ? { readonly body: ParsedBody<B> } : unknown
    >
  >;
  readonly beforeHandle?: ValidateStack<
    StackOf<H, "beforeHandle">,
    "beforeHandle",
    BeforeHandleCtx<Path, S, H, B>
  >;
  readonly beforeResponse?: ValidateStaticStack<
    StackOf<H, "beforeResponse">,
    "beforeResponse",
    ResponseCtx<Path, S, H, B>
  >;
  readonly afterResponse?: ValidateStaticStack<
    StackOf<H, "afterResponse">,
    "afterResponse",
    ResponseCtx<Path, S, H, B>
  >;
  readonly onError?: ValidateStaticStack<
    StackOf<H, "onError">,
    "onError",
    ErrorCtx<Path, S, H, B>
  >;
};
