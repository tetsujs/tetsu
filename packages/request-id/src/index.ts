/**
 * A request id: in the context, on the response, and in every log line
 * that carries it.
 *
 * ```ts
 * const id = requestId();
 *
 * createApp({ hooks: { beforeParse: [id] }, routes });
 * ```
 *
 * The lines themselves are `@tetsujs/request-log`'s: its records carry the
 * id when this hook ran before them, which is what joins the line of a
 * request's arrival, the line of its end, and a failure report.
 *
 * This is the package that shows a **typed contribution**: `requestId()`
 * puts `ctx.requestId` into the context, and a route that mounts it sees
 * it as a `string` without anyone annotating anything.
 *
 * Mounted on the application, as above, the field is there at runtime but
 * not in the types of a route's handler — an application does not know
 * which routes it will hold, so it cannot type them, the same reason a
 * group cannot. Three ways to read it typed: mount the hook on the route
 * that needs it; read it from an application hook mounted after it, which
 * sees what the application's earlier hooks contributed; or declare the
 * requirement with `Requires<{ requestId: string }>` on the hook that
 * reads it, which the core then checks.
 *
 * @module
 */

import { hook } from "@tetsujs/core";

/** How the id is obtained and where it is written. */
export interface RequestIdOptions {
  /**
   * The header the id is written to, and read from when trusted.
   * Defaults to `x-request-id`.
   */
  readonly header?: string;

  /**
   * Whether an incoming header is trusted.
   *
   * Off by default, and deliberately: an id from the outside is a value a
   * client chose, so trusting it lets one client stamp another's log
   * lines. Turn it on only behind a proxy that overwrites the header.
   * An empty header counts as none, and the id is generated.
   */
  readonly trustIncoming?: boolean;

  /** How an id is made. `crypto.randomUUID()` by default. */
  readonly generate?: () => string;
}

/**
 * The hook {@link requestId} returns.
 *
 * Read off the factory rather than written by hand: an annotation of
 * `AnyHook` would erase both the slot and the contribution, and the stack
 * validation would reject the hook it was handed.
 */
export type RequestIdHook = ReturnType<typeof requestId>;

/**
 * Gives every request an id, in the context and on the response.
 *
 * @example
 * ```ts
 * const id = requestId({ trustIncoming: true });
 *
 * route({
 *   method: "GET",
 *   path: "/orders",
 *   hooks: { beforeParse: [id] },
 *   handler: (ctx) => logger.info({ requestId: ctx.requestId }, "listing"),
 *   //                                    ^? string
 * });
 * ```
 */
export function requestId(options: RequestIdOptions = {}) {
  const header = options.header ?? "x-request-id";
  const generate = options.generate ?? (() => crypto.randomUUID());

  return hook.beforeParse((ctx) => {
    const incoming = options.trustIncoming ? ctx.req.headers.get(header) : null;

    const id = incoming || generate();

    ctx.out.headers.set(header, id);

    return { requestId: id };
  });
}
