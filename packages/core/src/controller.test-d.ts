/**
 * Type-level tests for controllers declared with `controller()`.
 *
 * The wrapper must be invisible to the types that matter: a handler's
 * context inferred from the hooks built inside the factory, the checks on
 * a hook's requirements, the application's route map, and the
 * dependencies — read from the factory's parameter and checked where the
 * controller is made.
 *
 * @module
 */

import { mockSchema } from "../test-utils/mock-schema.ts";
import type { Equal, Expect } from "../test-utils/types.ts";
import type { AppRoutes } from "./app.ts";
import { createApp } from "./app.ts";
import type { Requires } from "./context.ts";
import { controller } from "./controller.ts";
import { group } from "./group.ts";
import { hook } from "./hook.ts";
import { route } from "./route.ts";

declare function expectType<T>(value: T): void;

class AuthService {
  requestCode(email: string) {
    return { sent: email };
  }
}
class Sessions {
  verify() {
    return { user: { id: "u1" } };
  }
}
interface AuthDeps {
  readonly auth: AuthService;
  readonly sessions: Sessions;
  readonly limitBytes: number;
}

const Body = mockSchema<{ email: string }>();
const needsTenant = hook.beforeHandle((ctx: Requires<{ tenant: string }>) => {
  void ctx.tenant;
});

export const authController = controller(
  "Auth",
  ({ auth, sessions, limitBytes }: AuthDeps) => {
    const session = hook.beforeParse(() => sessions.verify());

    return {
      requestCode: route({
        method: "POST",
        path: "/code",
        schema: { body: Body },
        hooks: { beforeParse: [session] },
        maxBodySize: limitBytes,
        handler: (ctx) => {
          expectType<string>(ctx.user.id);
          expectType<string>(ctx.body.email);
          return auth.requestCode(ctx.body.email);
        },
      }),

      broken: route({
        method: "GET",
        path: "/broken",
        // @ts-expect-error nothing provides tenant
        hooks: { beforeHandle: [needsTenant] },
        handler: () => null,
      }),
    };
  },
);

export const healthController = controller("Health", () => ({
  live: route({ method: "GET", path: "/live", handler: () => ({ ok: true }) }),
}));

type Deps = Parameters<typeof authController>[0];
export type depsCases = [Expect<Equal<Deps, AuthDeps>>];

const app = createApp({
  routes: group("/dash", {
    children: [
      authController({
        auth: new AuthService(),
        sessions: new Sessions(),
        limitBytes: 1024,
      }),
      healthController(),
    ],
  }),
});

type Map = AppRoutes<typeof app>;
export type mapCases = [
  Expect<
    Equal<keyof Map, "POST /dash/code" | "GET /dash/broken" | "GET /dash/live">
  >,
  Expect<Equal<Map["POST /dash/code"]["method"], "POST">>,
];

// @ts-expect-error the dependencies are checked where the controller is made
authController({ auth: new AuthService() });

// @ts-expect-error a controller without dependencies takes none
healthController({});

const unit = authController({
  auth: new AuthService(),
  sessions: new Sessions(),
  limitBytes: 1,
});
expectType<(ctx: never) => unknown>(unit.requestCode.handler);
