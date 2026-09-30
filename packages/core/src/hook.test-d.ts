/**
 * Type-level tests for lifecycle hook factories.
 *
 * @module
 */

import type { Equal, Expect } from "../test-utils/types.ts";
import { createApp } from "./app.ts";
import type { BaseCtx, Requires } from "./context.ts";
import {
  type AnyHook,
  type ExtOf,
  hook,
  type ReqOf,
  type SlotOf,
} from "./hook.ts";
import type { PipelineCtx } from "./pipeline.ts";
import { route } from "./route.ts";

declare function verifyToken(
  header: string | null,
): Promise<{ id: string } | null>;

/** May skip its extension, so it contributes an optional one. */
const optionalAuth = hook.beforeParse(async (ctx) => {
  const user = await verifyToken(ctx.req.headers.get("authorization"));
  return user ? { user } : undefined;
});

/** Always contributes, because the failure path throws. */
const auth = hook.beforeParse(async (ctx) => {
  const user = await verifyToken(ctx.req.headers.get("authorization"));

  if (!user) {
    throw new Error("unauthorized");
  }

  return { user };
});

const withOrder = hook.beforeHandle(
  (ctx: Requires<{ params: { id: string }; user: { id: string } }>) => ({
    order: { id: ctx.params.id },
  }),
);

const observer = hook.afterResponse((ctx) => {
  void ctx.res.status;
});

const shortCircuit = hook.beforeParse(() => new Response(null));

declare const flag: boolean;

const mixed = hook.beforeParse(() =>
  flag ? { traceId: "t" } : new Response(null),
);

// @ts-expect-error a primitive is not a valid hook return
hook.beforeParse(() => "nope");

// @ts-expect-error a bare function is not a hook — wrap it in a hook.* factory
export const bare: AnyHook = () => ({});

/** Tries to smuggle pipeline-owned fields; only `user` survives in the type. */
const smuggler = hook.beforeParse(() => ({
  server: { requestIP: () => "1.2.3.4" },
  res: new Response(null),
  user: { id: "u1" },
}));

const pureSmuggler = hook.beforeParse(() => ({ error: "boom" }));

/**
 * Every pipeline-owned key at once — the type-level mirror of
 * `protectedKeys`. Dropping any key from `PipelineOwnedKey` leaves it in
 * the extension and fails the assertion below.
 */
interface EveryOwnedKey {
  __proto__: { polluted: true };
  constructor: string;
  prototype: string;
  req: string;
  server: string;
  out: string;
  route: string;
  res: string;
  error: string;
  user: { id: string };
}

declare const everyOwnedKey: EveryOwnedKey;

const totalSmuggler = hook.beforeParse(() => everyOwnedKey);

/**
 * The same mirror, derived from `PipelineCtx` instead of a hand-written
 * list: a field added to the pipeline context and forgotten in
 * `PipelineOwnedKey` shows up in the extension here.
 */
type PipelineFields = Omit<
  PipelineCtx,
  "params" | "query" | "body" | "headers" | "cookies"
>;

declare const pipelineFields: PipelineFields & { user: { id: string } };

const contextSmuggler = hook.beforeParse(() => pipelineFields);

const traceKey = Symbol("trace");

/** A symbol key is never copied by the merge, so it must not be typed. */
const symbolSmuggler = hook.beforeParse(() => ({
  [traceKey]: "t1",
  user: { id: "u1" },
}));

/**
 * A class instance contributes its own fields only; `label` lives on the
 * prototype and never arrives. The compiler cannot see the difference —
 * this pins the documented limit, not a guarantee.
 */
class Session {
  constructor(readonly id: string) {}

  label(): string {
    return `session ${this.id}`;
  }
}

const instanceHook = hook.beforeParse(() => new Session("s1"));

export type cases = [
  Expect<Equal<SlotOf<typeof auth>, "beforeParse">>,
  Expect<Equal<SlotOf<typeof observer>, "afterResponse">>,
  Expect<Equal<ExtOf<typeof auth>, { user: { id: string } }>>,
  Expect<Equal<keyof ExtOf<typeof optionalAuth>, "user">>,
  Expect<
    Equal<
      Record<string, never> extends ExtOf<typeof optionalAuth> ? true : false,
      true
    >
  >,
  Expect<
    Equal<NonNullable<ExtOf<typeof optionalAuth>["user"]>, { id: string }>
  >,
  Expect<Equal<ExtOf<typeof withOrder>, { order: { id: string } }>>,
  Expect<Equal<ExtOf<typeof observer>, unknown>>,
  Expect<Equal<ExtOf<typeof shortCircuit>, unknown>>,
  Expect<Equal<ExtOf<typeof mixed>, { traceId: string }>>,
  Expect<
    Equal<
      ReqOf<typeof withOrder>,
      Requires<{ params: { id: string }; user: { id: string } }>
    >
  >,
  Expect<
    Equal<
      ReqOf<typeof auth>,
      BaseCtx & { readonly params: Record<string, string> }
    >
  >,
  Expect<Equal<keyof ExtOf<typeof smuggler>, "user">>,
  Expect<Equal<ExtOf<typeof smuggler>, { user: { id: string } }>>,
  Expect<Equal<keyof ExtOf<typeof totalSmuggler>, "user">>,
  Expect<Equal<ExtOf<typeof totalSmuggler>, { user: { id: string } }>>,
  Expect<Equal<keyof ExtOf<typeof contextSmuggler>, "user">>,
  Expect<Equal<keyof ExtOf<typeof symbolSmuggler>, "user">>,
  Expect<Equal<ExtOf<typeof symbolSmuggler>, { user: { id: string } }>>,
  Expect<Equal<keyof ExtOf<typeof instanceHook>, "id" | "label">>,
  Expect<Equal<keyof ExtOf<typeof pureSmuggler>, never>>,
];

/** An `onError` hook answers with a response, or passes the error on. */
export const mapsToResponse = hook.onError((ctx) =>
  ctx.error instanceof RangeError
    ? Response.json({ error: "OUT_OF_RANGE" }, { status: 409 })
    : undefined,
);

export const mapsLater = hook.onError(async () =>
  Response.json({ error: "LATER" }, { status: 409 }),
);

export const passesOn = hook.onError(() => {});

export const requiresToMap = hook.onError(
  (ctx: Requires<{ error: unknown; requestId: string }>) =>
    ctx.requestId === "" ? undefined : new Response(null, { status: 500 }),
);

// @ts-expect-error an object from onError is not a body: the runtime takes only a Response
export const answersWithObject = hook.onError(() => ({ status: 409 }));

// @ts-expect-error nor is an object it resolves to
export const resolvesToObject = hook.onError(async () => ({ status: 409 }));

const staged = new Map<string, number>();

/** The other slots still take a hook whose value is ignored. */
export const decorates = hook.beforeResponse(() => staged.set("seen", 1));

export const observes = hook.afterResponse(() => staged.set("seen", 2));

/** An observer reads what the response says, never what it carries. */
export const readsStatus = hook.afterResponse((ctx) => {
  const status: number = ctx.res.status;
  const type: string | null = ctx.res.headers.get("content-type");

  void [status, type, ctx.res.ok];
});

export const readsBody = hook.afterResponse(async (ctx) => {
  // @ts-expect-error the body is on its way to Bun: reading it breaks the response
  await ctx.res.text();
});

export const readsStream = hook.afterResponse((ctx) => {
  // @ts-expect-error nor its stream
  void ctx.res.body;
});

export const clonesLate = hook.afterResponse((ctx) => {
  // @ts-expect-error nor a clone, which fails once Bun has the body
  void ctx.res.clone();
});

/** A `beforeResponse` hook still holds the whole response, and may clone it. */
export const clonesEarly = hook.beforeResponse((ctx) => {
  void ctx.res.clone().text();
});

// A set of hooks shared between applications, spread into each slot where
// it is mounted — the README's alternative to joining `hooks` objects. The
// set is `as const`, so every slot stays a tuple and the order is checked.
const sharedId = hook.beforeParse(() => ({ requestId: "r1" }));
const sharedScope = hook.beforeParse(
  (ctx: Requires<{ requestId: string }>) => ({ tag: ctx.requestId }),
);
const sharedLog = hook.afterResponse(() => undefined);
const common = { beforeParse: [sharedId], afterResponse: [sharedLog] } as const;

export const spreadInOrder = createApp({
  hooks: {
    beforeParse: [...common.beforeParse, sharedScope],
    afterResponse: [...common.afterResponse],
  },
  routes: { get: route({ method: "GET", path: "/", handler: () => null }) },
});

export const spreadOutOfOrder = createApp({
  // @ts-expect-error sharedScope needs requestId, which the set gives after it
  hooks: { beforeParse: [sharedScope, ...common.beforeParse] },
  routes: { get: route({ method: "GET", path: "/", handler: () => null }) },
});

const widened = { beforeParse: [sharedId] };

export const spreadWidened = createApp({
  // @ts-expect-error without `as const` the set is an array, and cannot be checked
  hooks: { beforeParse: [...widened.beforeParse, sharedScope] },
  routes: { get: route({ method: "GET", path: "/", handler: () => null }) },
});
