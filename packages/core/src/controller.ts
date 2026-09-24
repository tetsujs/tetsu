/**
 * Controllers, declared as named factories.
 *
 * A controller is the routes of one part of an API, built once at
 * startup from what they depend on. Everything a route declares — its
 * hooks, its schemas, its body limit — is read when the route is
 * declared, so the dependencies have to be there by then. A function
 * that takes them and returns the routes has them from its first line; a
 * class does not, because its fields are initialized before its
 * constructor's parameters are assigned, and a hook built from a
 * constructor argument in a field would be built from `undefined`.
 *
 * The name is part of the declaration, and it is a contract rather than
 * an identifier: `@tetsujs/openapi` builds every `operationId` from it,
 * and a generated client names its methods after those. Renaming the
 * variable that holds the factory changes nothing a client sees; changing
 * the name does, and it is written where that is visible.
 *
 * @module
 */

/**
 * Where a controller built by {@link controller} keeps its name.
 *
 * A symbol, set as a non-enumerable property: routes are collected with
 * `Object.entries`, which sees neither, and the route map in the types
 * skips a field that is not a route. Internal to the core.
 */
export const controllerName: unique symbol = Symbol("tetsu.controller");

/**
 * Declares a controller: its name, and a function from its dependencies to
 * its routes.
 *
 * Returns that function, named: calling it with the dependencies gives an
 * ordinary object whose fields are the routes, so a handler is unit-tested
 * as `authController(fakes).requestCode.handler(testCtx(…))`. A controller
 * with no dependencies takes none — `controller("Health", () => ({ … }))`,
 * called as `healthController()`: one form, whatever it depends on.
 *
 * The dependencies' type is what the function declares for its parameter,
 * and `Parameters<typeof authController>[0]` reads it back for the code
 * that wires the application.
 *
 * Two controllers of one application may not share a name — the route
 * table refuses it at startup, because their `operationId`s would collide.
 *
 * @example
 * ```ts
 * export interface AuthDeps {
 *   readonly auth: AuthService;
 *   readonly captcha: CaptchaService;
 * }
 *
 * export const authController = controller("Auth", ({ auth, captcha }: AuthDeps) => {
 *   const passCaptcha = hook.beforeParse((ctx) => captcha.verify(ctx));
 *
 *   return {
 *     requestCode: route({
 *       method: "POST",
 *       path: "/code",
 *       schema: { body: RequestCode },
 *       hooks: { beforeParse: [passCaptcha] },
 *       handler: (ctx) => auth.requestCode(ctx.body.email),
 *     }),
 *   };
 * });
 *
 * // main.ts
 * createApp({ routes: authController({ auth, captcha }) });
 * ```
 */
export function controller<Deps extends readonly unknown[], R extends object>(
  name: string,
  build: (...deps: Deps) => R,
): (...deps: Deps) => R {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      "A controller needs a name: it is what every operationId of its routes is built from",
    );
  }

  return (...deps) => {
    const routes = build(...deps);

    Object.defineProperty(routes, controllerName, { value: name });

    return routes;
  };
}

/**
 * The name a mounted object goes by: the one `controller()` gave it, or
 * its class's, or none — an object literal has nothing to be named after,
 * and calling it `"Object"` would put the same name on every one of them.
 * Internal to the core.
 */
export function nameOf(node: object): string | undefined {
  const given = (node as { readonly [controllerName]?: unknown })[
    controllerName
  ];

  if (typeof given === "string") {
    return given;
  }

  const maker = (node as { readonly constructor?: unknown }).constructor;

  if (typeof maker !== "function" || maker === Object) {
    return undefined;
  }

  return maker.name === "" ? undefined : maker.name;
}
