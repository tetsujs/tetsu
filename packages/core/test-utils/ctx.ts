/**
 * Test helper for calling a route handler directly.
 *
 * A `RouteDef` keeps its handler fully typed, so a unit test can skip HTTP
 * entirely: build the context the handler expects and call it. Anything the
 * handler does not touch stays absent, and touching the stub server fails
 * loudly rather than silently returning `undefined`.
 *
 * @module
 */

import type { Server } from "bun";
import { OutgoingSettings } from "../src/context.ts";
import type { CookieOptions } from "../src/cookie.ts";
import { cookieSealer, sealerKey } from "../src/cookie.ts";
import type { BaseCtx, RouteInfo } from "../src/index.ts";

const stubServer = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `ctx.server.${String(property)} was used in a unit test — serve the app (test-utils/server.ts) to exercise server-dependent code`,
      );
    },
  },
) as Server<unknown>;

/**
 * Builds a context for a direct handler call.
 *
 * @example
 * ```ts
 * const controller = new OrdersController(mockOrders);
 *
 * const result = await controller.cancel.handler(
 *   testCtx({ params: { id: "1" }, user, order }),
 * );
 *
 * expect(result.status).toBe("cancelled");
 * ```
 *
 * @example Overriding the request
 * ```ts
 * testCtx({
 *   params: {},
 *   req: new Request("http://test/orders?full=true"),
 * });
 * ```
 */
export function testCtx<const Parts extends object>(
  parts: Parts,
  options: TestCtxOptions = {},
): Parts & BaseCtx & { readonly route: RouteInfo } {
  const sealer = cookieSealer(options.cookies);

  return {
    req: new Request("http://test/"),
    server: stubServer,
    out: new OutgoingSettings(sealer),
    route: stubRoute,
    startedAt: performance.now(),
    [sealerKey]: sealer,
    ...parts,
  } as Parts & BaseCtx & { readonly route: RouteInfo };
}

/** How the hand-built context behaves where the application's options would decide. */
export interface TestCtxOptions {
  /**
   * The application's `cookies` option: with it, a cookie the code sets
   * on `ctx.out.cookies` is signed as it would be, and `signedCookie()`
   * opens one the request carries.
   *
   * @example
   * ```ts
   * const ctx = testCtx(
   *   { req: new Request("http://test/", { headers: { cookie } }) },
   *   { cookies: { secret: "test-secret", sign: ["session"] } },
   * );
   * ```
   */
  readonly cookies?: CookieOptions;
}

/**
 * The route a hand-built context matched, when the test did not say.
 *
 * Present rather than absent because a handler's own context always has
 * one, and a helper that left it out would make every unit test write a
 * route it does not care about. Named after this helper rather than after
 * a plausible endpoint: a test asserting on `ctx.route` should pass its
 * own, and `"testCtx"` in a failure message says where the value came
 * from instead of looking like a real controller.
 *
 * Unlike the server stub it does not throw on use — reading the path of a
 * route is harmless, where reaching for the server in a unit test is the
 * mistake the loud stub exists to catch.
 */
const stubRoute: RouteInfo = {
  method: "GET",
  path: "/",
  controller: "testCtx",
};
