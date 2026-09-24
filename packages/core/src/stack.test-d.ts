/**
 * Type-level tests for hook stack validation.
 *
 * @module
 */

import type { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type {
  BaseCtx,
  EarlyCtx,
  Requires,
  SchemaConfig,
  ValidatedCtx,
} from "./context.ts";
import { hook } from "./hook.ts";
import type {
  ErrorCtx,
  ExtOfStack,
  HandlerCtx,
  HookRequirementError,
  HookSlotError,
  HookStackError,
  Merge,
  ResponseCtx,
  StackOf,
  ValidateGroupStack,
  ValidateHooks,
  ValidateStack,
  ValidateStaticStack,
} from "./stack.ts";

const auth = hook.beforeParse(() => ({ user: { id: "u1" } }));

const tenant = hook.beforeParse((ctx: Requires<{ user: { id: string } }>) => ({
  tenant: ctx.user.id,
}));

const withOrder = hook.beforeHandle(
  (ctx: Requires<{ params: { id: string }; user: { id: string } }>) => ({
    order: { id: ctx.params.id },
  }),
);

type CancelPath = "/orders/:id/cancel";

type EarlyCancel = EarlyCtx<CancelPath>;

type ValidatedCancel = ValidatedCtx<CancelPath, SchemaConfig>;

type RequirementMessage =
  "Hook requires context 'user' which is not provided by path, schema or preceding hooks";

type SlotMessage =
  "Hook of slot 'beforeHandle' cannot be placed into 'beforeParse'";

export type cases = [
  Expect<
    Equal<
      ValidateStack<readonly [typeof auth], "beforeParse", EarlyCancel>,
      readonly [typeof auth]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof auth, typeof tenant],
        "beforeParse",
        EarlyCancel
      >,
      readonly [typeof auth, typeof tenant]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof tenant, typeof auth],
        "beforeParse",
        EarlyCancel
      >,
      readonly [HookRequirementError<RequirementMessage>, typeof auth]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof withOrder],
        "beforeHandle",
        ValidatedCancel & ExtOfStack<readonly [typeof auth]>
      >,
      readonly [typeof withOrder]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof withOrder],
        "beforeHandle",
        ValidatedCancel
      >,
      readonly [HookRequirementError<RequirementMessage>]
    >
  >,
  Expect<
    Equal<
      ValidateStack<readonly [typeof withOrder], "beforeParse", EarlyCancel>,
      readonly [HookSlotError<SlotMessage>]
    >
  >,
  Expect<
    Equal<
      StackOf<{ beforeParse: readonly [typeof auth] }, "beforeParse">,
      readonly [typeof auth]
    >
  >,
  Expect<
    Equal<
      StackOf<{ beforeParse: readonly [typeof auth] }, "beforeHandle">,
      readonly []
    >
  >,
  Expect<
    Equal<
      keyof ExtOfStack<readonly [typeof auth, typeof withOrder]>,
      "user" | "order"
    >
  >,
];

type FullHandlerCtx = HandlerCtx<
  CancelPath,
  SchemaConfig,
  {
    beforeParse: readonly [typeof auth];
    beforeHandle: readonly [typeof withOrder];
  }
>;

type EmptyHandlerCtx = HandlerCtx<CancelPath, SchemaConfig, SchemaConfig>;

export type handlerCtxCases = [
  Expect<
    Equal<
      keyof FullHandlerCtx,
      | "req"
      | "server"
      | "out"
      | "route"
      | "startedAt"
      | "params"
      | "user"
      | "order"
    >
  >,
  Expect<Equal<FullHandlerCtx["user"], { id: string }>>,
  Expect<Equal<FullHandlerCtx["order"], { id: string }>>,
  Expect<Equal<FullHandlerCtx["params"], { id: string }>>,
  Expect<
    Equal<
      keyof EmptyHandlerCtx,
      "req" | "server" | "out" | "route" | "startedAt" | "params"
    >
  >,
];

const firstUser = hook.beforeParse(() => ({ user: { id: "a" } }));

const laterUser = hook.beforeParse(() => ({ user: { name: "b" } }));

const optionalTenant = hook.beforeParse(() =>
  Math.trunc(1) === 1 ? { tenant: "t" } : undefined,
);

const maybeLaterUser = hook.beforeParse(() =>
  Math.trunc(1) === 1 ? { user: { name: "b" } } : undefined,
);

type CollidingCtx = ExtOfStack<readonly [typeof firstUser, typeof laterUser]>;

type OptionalCtx = ExtOfStack<readonly [typeof optionalTenant]>;

type MaybeOverridden = ExtOfStack<
  readonly [typeof firstUser, typeof maybeLaterUser]
>;

type Response_ = ResponseCtx<
  "/orders/:id",
  SchemaConfig,
  { beforeParse: readonly [typeof auth] }
>;

type NumberedSchema = { params: ReturnType<typeof mockSchema<{ id: number }>> };

type ResponseWithParamsSchema = ResponseCtx<
  "/orders/:id",
  NumberedSchema,
  { beforeParse: readonly [typeof auth] }
>;

/**
 * A key the extension only may contribute replaces the earlier one and is
 * optional: `contributed | undefined`, not `earlier | contributed`. The
 * precise form cost the compiler about a hundred times the types (see
 * `Merge`); these cases pin the trade, so a change back is a decision,
 * not an accident.
 */
export type mergeCases = [
  Expect<Equal<keyof CollidingCtx, "user">>,
  Expect<Equal<CollidingCtx["user"], { name: string }>>,
  Expect<Equal<keyof OptionalCtx, "tenant">>,
  Expect<Equal<OptionalCtx["tenant"], string | undefined>>,
  Expect<Equal<Merge<{ a: 1; b: 2 }, { b: 3 }>["b"], 3>>,
  Expect<Equal<Merge<{ a: 1; b: 2 }, { b: 3 }>["a"], 1>>,
  Expect<Equal<Merge<{ a: 1 }, unknown>, { a: 1 }>>,
  Expect<Equal<Merge<{ a: 1 }, { a?: 2 }>["a"], 2 | undefined>>,
  Expect<Equal<Merge<{ a: 1 }, { b?: 2 }>["b"], 2 | undefined>>,
  Expect<Equal<MaybeOverridden["user"], { name: string } | undefined>>,
  Expect<Equal<keyof MaybeOverridden, "user">>,
];

const maybeTenant = hook.beforeParse(() =>
  Math.trunc(1) === 1 ? { tenant: "a" } : undefined,
);

const maybeTenantAgain = hook.beforeParse(() =>
  Math.trunc(1) === 1 ? { tenant: "b" } : undefined,
);

const readsMaybeTenant = hook.beforeParse(
  (ctx: Requires<{ tenant?: string }>) => {
    void ctx.tenant;
  },
);

type BothMaybe = Merge<{ a?: 1 }, { a?: 2 }>;

const observesResponse = hook.beforeResponse(() => {});

const observesFinished = hook.afterResponse(() => {});

const observesError = hook.onError(() => {});

type ResponseSlotHooks = {
  beforeResponse: readonly [typeof observesResponse];
  afterResponse: readonly [typeof observesFinished];
  onError: readonly [typeof observesError];
};

type ValidatedResponseSlots = ValidateHooks<
  ResponseSlotHooks,
  "/orders/:id",
  SchemaConfig
>;

/**
 * A key both sides may leave out stays one that may be left out: when
 * neither contributes it, it is absent at runtime, not present and
 * `undefined`. Typing it as a required `T | undefined` is the same thing
 * only until `exactOptionalPropertyTypes` tells the two apart — and then
 * `ResponseCtx`, which merges an optional `route` into a partial one,
 * refused every hook a route mounted in its response and error slots.
 * The last three cases are that refusal, and only `check:strictest` sees
 * it fail; the first one catches the cause under any flags. The value is
 * the later side's, as everywhere a key is only maybe contributed.
 */
export type optionalOnBothSidesCases = [
  Expect<
    Equal<
      Record<string, never> extends Pick<BothMaybe, "a"> ? true : false,
      true
    >
  >,
  Expect<Equal<NonNullable<BothMaybe["a"]>, 2>>,
  Expect<
    Equal<
      ValidateStack<
        readonly [
          typeof maybeTenant,
          typeof maybeTenantAgain,
          typeof readsMaybeTenant,
        ],
        "beforeParse",
        EarlyCancel
      >,
      readonly [
        typeof maybeTenant,
        typeof maybeTenantAgain,
        typeof readsMaybeTenant,
      ]
    >
  >,
  Expect<
    Equal<
      NonNullable<ValidatedResponseSlots["beforeResponse"]>,
      readonly [typeof observesResponse]
    >
  >,
  Expect<
    Equal<
      NonNullable<ValidatedResponseSlots["afterResponse"]>,
      readonly [typeof observesFinished]
    >
  >,
  Expect<
    Equal<
      NonNullable<ValidatedResponseSlots["onError"]>,
      readonly [typeof observesError]
    >
  >,
];

const readsUnionParams = hook.beforeResponse(
  (ctx: Requires<{ params: { id: string } | { id: number } }>) => {
    void ctx.params.id;
  },
);

const wantsRawParams = hook.beforeResponse(
  (ctx: Requires<{ params: { id: string } }>) => {
    void ctx.params.id;
  },
);

const wantsTenantParams = hook.beforeResponse(
  (ctx: Requires<{ params: { tenantId: string } }>) => {
    void ctx.params.tenantId;
  },
);

type ParamsMessage =
  "Hook requires context 'params' which is not provided by path, schema or preceding hooks";

/** Its return value is ignored by the runtime, so it must not extend the context. */
const pretender = hook.beforeResponse(() => ({ flag: true }));

const wantsFlag = hook.beforeResponse((ctx: Requires<{ flag: boolean }>) => {
  void ctx.flag;
});

type FlagMessage =
  "Hook requires context 'flag' which is not provided by path, schema or preceding hooks";

const wantsRawOnError = hook.onError(
  (ctx: Requires<{ params: { id: string } }>) => {
    void ctx.params.id;
  },
);

type ErrorWithSchema = ErrorCtx<
  "/orders/:id",
  NumberedSchema,
  { beforeParse: readonly [typeof auth] }
>;

export type staticStackCases = [
  Expect<
    Equal<
      ValidateStaticStack<
        readonly [typeof pretender, typeof wantsFlag],
        "beforeResponse",
        Response_
      >,
      readonly [typeof pretender, HookRequirementError<FlagMessage>]
    >
  >,
  Expect<
    Equal<
      NonNullable<
        ValidateHooks<
          { beforeResponse: readonly [typeof pretender, typeof wantsFlag] },
          "/orders/:id",
          SchemaConfig
        >["beforeResponse"]
      >,
      readonly [typeof pretender, HookRequirementError<FlagMessage>]
    >
  >,
  Expect<
    Equal<
      keyof ErrorWithSchema,
      | "req"
      | "server"
      | "out"
      | "route"
      | "startedAt"
      | "params"
      | "user"
      | "error"
    >
  >,
  Expect<Equal<ErrorWithSchema["params"], { id: string } | { id: number }>>,
  Expect<Equal<ErrorWithSchema["error"], unknown>>,
  Expect<Equal<ErrorWithSchema["user"], { id: string } | undefined>>,
  Expect<
    Equal<
      ValidateStaticStack<
        readonly [typeof wantsRawOnError],
        "onError",
        ErrorWithSchema
      >,
      readonly [HookRequirementError<ParamsMessage>]
    >
  >,
];

export type responseCtxCases = [
  Expect<Equal<Response_["res"], Response>>,
  Expect<Equal<Response_["req"], BaseCtx["req"]>>,
  Expect<Equal<Response_["user"], { id: string } | undefined>>,
  Expect<Equal<Response_["params"], { id: string }>>,
  Expect<
    Equal<ResponseWithParamsSchema["params"], { id: string } | { id: number }>
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof readsUnionParams],
        "beforeResponse",
        ResponseWithParamsSchema
      >,
      readonly [typeof readsUnionParams]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof wantsRawParams],
        "beforeResponse",
        Response_
      >,
      readonly [typeof wantsRawParams]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof wantsRawParams],
        "beforeResponse",
        ResponseWithParamsSchema
      >,
      readonly [HookRequirementError<ParamsMessage>]
    >
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof wantsTenantParams],
        "beforeResponse",
        ResponseWithParamsSchema
      >,
      readonly [HookRequirementError<ParamsMessage>]
    >
  >,
];

type WidenedMessage =
  "A widened hook array loses its element types and cannot be checked — write the hooks in the slot itself, or declare the array as const";

type Widened = readonly HookStackError<WidenedMessage>[];

/**
 * A stack that reaches a validator as an array type rather than a tuple is
 * unknowable — every validator has to say so, and an empty tuple must
 * still pass all three.
 */
export type widenedArrayCases = [
  Expect<
    Equal<ValidateStack<(typeof auth)[], "beforeParse", EarlyCancel>, Widened>
  >,
  Expect<
    Equal<
      ValidateStack<
        readonly [typeof auth, ...(typeof auth)[]],
        "beforeParse",
        EarlyCancel
      >,
      readonly [typeof auth, ...Widened]
    >
  >,
  Expect<
    Equal<
      ValidateStaticStack<(typeof pretender)[], "beforeResponse", Response_>,
      Widened
    >
  >,
  Expect<Equal<ValidateGroupStack<(typeof auth)[], "beforeParse">, Widened>>,
  Expect<
    Equal<ValidateStack<readonly [], "beforeParse", EarlyCancel>, readonly []>
  >,
  Expect<
    Equal<
      ValidateStaticStack<readonly [], "beforeResponse", Response_>,
      readonly []
    >
  >,
  Expect<Equal<ValidateGroupStack<readonly [], "beforeParse">, readonly []>>,
];

const normalizesDeclaredParts = hook.beforeValidation(() => ({
  body: { qty: "7" },
  query: { page: "2" },
}));

const overridesAfterValidation = hook.beforeHandle(() => ({
  body: { qty: true },
}));

type QtySchema = { body: ReturnType<typeof mockSchema<{ qty: number }>> };

type NormalizedHandler = HandlerCtx<
  "/orders/:id",
  QtySchema,
  { beforeValidation: readonly [typeof normalizesDeclaredParts] }
>;

type LateOverrideHandler = HandlerCtx<
  "/orders/:id",
  QtySchema,
  {
    beforeValidation: readonly [typeof normalizesDeclaredParts];
    beforeHandle: readonly [typeof overridesAfterValidation];
  }
>;

type NormalizedResponse = ResponseCtx<
  "/orders/:id",
  QtySchema,
  { beforeValidation: readonly [typeof normalizesDeclaredParts] }
>;

/**
 * Validation runs after the pre-validation slots and overwrites the parts
 * it has a schema for, so those parts keep the schema's type however a
 * hook typed its contribution; parts without a schema stay the hook's.
 * `beforeHandle` runs after validation and wins in both worlds.
 */
export type schemaPrecedenceCases = [
  Expect<Equal<NormalizedHandler["body"], { qty: number }>>,
  Expect<Equal<NormalizedHandler["query"], { page: string }>>,
  Expect<Equal<LateOverrideHandler["body"], { qty: boolean }>>,
  Expect<Equal<NonNullable<NormalizedResponse["body"]>, { qty: number }>>,
  Expect<Equal<NonNullable<NormalizedResponse["query"]>, { page: string }>>,
];

const earlyContributesEveryPart = hook.beforeParse(() => ({
  params: { id: true },
  query: { page: true },
  headers: { tenant: true },
  cookies: { session: true },
}));

const lateContributesEveryPart = hook.beforeValidation(() => ({
  params: { id: 1n },
  query: { page: 1n },
  body: { qty: 1n },
  headers: { tenant: 1n },
  cookies: { session: 1n },
}));

type EverySchema = {
  params: ReturnType<typeof mockSchema<{ id: number }>>;
  query: ReturnType<typeof mockSchema<{ page: number }>>;
  body: ReturnType<typeof mockSchema<{ qty: number }>>;
  headers: ReturnType<typeof mockSchema<{ tenant: string }>>;
  cookies: ReturnType<typeof mockSchema<{ session: string }>>;
};

type EveryPartHooks = {
  beforeParse: readonly [typeof earlyContributesEveryPart];
  beforeValidation: readonly [typeof lateContributesEveryPart];
};

type EveryPartHandler = HandlerCtx<"/orders/:id", EverySchema, EveryPartHooks>;

type EveryPartResponse = ResponseCtx<
  "/orders/:id",
  EverySchema,
  EveryPartHooks
>;

/**
 * The precedence holds for every part a schema can own, not only the ones
 * that came first: a declared part is overwritten by validation, whichever
 * pre-validation slot contributed it and whatever type the contribution
 * had.
 */
export type schemaPrecedenceEveryPartCases = [
  Expect<Equal<EveryPartHandler["params"], { id: number }>>,
  Expect<Equal<EveryPartHandler["query"], { page: number }>>,
  Expect<Equal<EveryPartHandler["body"], { qty: number }>>,
  Expect<Equal<EveryPartHandler["headers"], { tenant: string }>>,
  Expect<Equal<EveryPartHandler["cookies"], { session: string }>>,
  Expect<Equal<NonNullable<EveryPartResponse["cookies"]>, { session: string }>>,
];
