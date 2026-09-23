/**
 * Type-level tests for lifecycle hook factories.
 *
 * @module
 */

import type { Equal, Expect } from "../test-utils/types.ts";
import type { BaseCtx, Requires } from "./context.ts";
import {
  type AnyHook,
  type ExtOf,
  hook,
  type ReqOf,
  type SlotOf,
  stack,
} from "./hook.ts";
import type { PipelineCtx } from "./pipeline.ts";

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

const secured = stack(auth, withOrder);

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
  Expect<Equal<typeof secured, readonly [typeof auth, typeof withOrder]>>,
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
